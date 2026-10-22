import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { basename, join } from 'node:path'
import {
  after,
  before,
  test as nodeTest,
  type TestContext,
  type TestFn,
  type TestOptions,
} from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { scan, treeId } from '../project/revisions.ts'
import { type Bridge, type StudioEvent, startBridge } from './bridge.ts'
import { call, nonce, page } from './fixtures/page.ts'
import { startRelay } from './fixtures/relay.ts'
import {
  CLOSE,
  isId,
  keyPair,
  makeId,
  makeNonce,
  relayUrl,
  seal,
  sessionKey,
  unseal,
} from './pairing.ts'
import { connectRelay } from './relay.ts'
import { NOTICE, noticeOnce, setTelemetry, telemetryStatus } from './telemetry.ts'

// The user's config (telemetry) and tokens (share) live in a home of the tests' own.
const home = tempDir('home')
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_TELEMETRY

// `node --test` waits forever by default: a test that hangs fails by itself, not the whole run.
const test = (name: string, a: TestFn | TestOptions, b?: TestFn) =>
  typeof a === 'function'
    ? nodeTest(name, { timeout: 60_000 }, a)
    : nodeTest(name, { timeout: 60_000, ...a }, b)

const SITE = 'https://shaderera.example'
const DEV = 'http://localhost:3000'
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const fixture = (root = tempDir('studio')) => {
  cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}
const asPage = (b: Bridge, origin = SITE) => ({
  Origin: origin,
  Authorization: `Bearer ${b.secret}`,
})
const jsonOf = (r: { body: Buffer }) => JSON.parse(r.body.toString('utf8'))

/** The bridge's events as the page's EventSource gets them (`?s=`, Origin). */
const events = (b: Bridge) => {
  const got: StudioEvent[] = []
  const waiting: { test: (e: StudioEvent) => boolean; done: (e: StudioEvent) => void }[] = []
  const req = httpRequest({
    host: '127.0.0.1',
    port: b.port,
    path: `/events?s=${b.secret}`,
    headers: { Origin: SITE },
  })
  const opened = new Promise<number>((done) =>
    req.on('response', (res) => {
      let text = ''
      res.on('data', (p: Buffer) => {
        text += p.toString('utf8')
        for (let at = text.indexOf('\n\n'); at >= 0; at = text.indexOf('\n\n')) {
          const block = text.slice(0, at)
          text = text.slice(at + 2)
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (!data) continue
          const e = JSON.parse(data) as StudioEvent
          got.push(e)
          for (const w of [...waiting])
            if (w.test(e)) {
              waiting.splice(waiting.indexOf(w), 1)
              w.done(e)
            }
        }
      })
      done(res.statusCode ?? 0)
    }),
  )
  req.on('error', () => {})
  req.end()
  return {
    opened,
    got,
    next: (t: (e: StudioEvent) => boolean) =>
      new Promise<StudioEvent>((done) => {
        const old = got.find(t)
        if (old) done(old)
        else waiting.push({ test: t, done })
      }),
    close: () => req.destroy(),
  }
}

let bridge: Bridge
let relay: Awaited<ReturnType<typeof startRelay>>
// Closed before the folder goes: after hooks run in the order they were added.
after(async () => {
  await bridge.close()
  await relay.close()
})
const root = fixture()
before(async () => {
  bridge = await startBridge({ root, api: SITE, site: SITE, origins: [SITE, DEV], settleMs: 50 })
  relay = await startRelay({ ttlMs: 300 })
})

test('a studio session id is 20 characters of the alphabet', () => {
  for (let i = 0; i < 200; i++) assert.ok(isId(makeId()))
  assert.equal(makeId().length, 20)
  assert.equal(isId('abcdefghjkmnpqrstuv0'), false)
  assert.equal(isId('abcdef'), false)
  assert.equal(isId('abcdefghjkmnpqrstuvwx'), false)
  assert.match(makeNonce(), /^[\w-]{22}$/)
})

/**
 * Closes the relay sides a test opened when it ends, passed or failed: a paired CLI left open
 * rejoins the closed relay for as long as the process runs, so the file would never end.
 */
const closeAtEnd = (t: TestContext, ...sides: ({ close: () => unknown } | { ws: WebSocket })[]) =>
  t.after(async () => {
    for (const side of sides) await ('ws' in side ? side.ws.close() : side.close())
  })

test('the CLI pairs through the relay, and only the page can open the bridge it sends', async (t) => {
  const id = makeId()
  const p = page(relay.origin, id)
  const paired = p.pair()
  // The page is there first; the CLI joins after (cli-joined, page-hello again).
  await p.opened
  let cliPaired = false
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '9.9.9', os: 'test', telemetry: true },
    onPaired: () => {
      cliPaired = true
    },
  })
  closeAtEnd(t, cli, p)
  const { hello, bridge: got } = await paired
  assert.deepEqual(
    { version: hello.version, os: hello.os, telemetry: hello.telemetry },
    { version: '9.9.9', os: 'test', telemetry: true },
  )
  assert.equal(got.port, bridge.port)
  assert.equal(got.secret, bridge.secret)
  assert.match(got.secret, /^[0-9a-f]{32}$/)
  // The relay saw only ciphertext.
  assert.ok(!relay.seen.some((frame) => frame.includes(bridge.secret)))
  for (let i = 0; i < 50 && !cliPaired; i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(cliPaired, 'the CLI hears paired')
  assert.equal(relay.sessions.get(id)?.paired, true)

  // Used: no second CLI, and no second page.
  const second = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '9.9.9', os: 'test', telemetry: true },
  })
  assert.equal((await second.closed).code, CLOSE.used)
  assert.equal(await page(relay.origin, id).closed, CLOSE.taken)
  cli.close()
  assert.equal((await p.next('cli-left')).type, 'cli-left')
})

test('a page without the nonce the CLI opened never gets the bridge or an answer', async (t) => {
  const id = makeId()
  const stranger = page(relay.origin, id)
  await stranger.opened
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
  })
  closeAtEnd(t, cli, stranger)
  await stranger.next('cli-joined')
  const mine = await keyPair()
  stranger.send({ type: 'page-hello', pub: mine.pub })
  const hello = await stranger.next('cli-hello')
  const key = await sessionKey(mine.privateKey, hello.pub as string, id)
  // Another nonce; the nonce under a key that is not its hello's; a request with no proof; paired.
  stranger.send({ type: 'page-proof', ...(await seal(key, { nonce: makeNonce() })) })
  const other = await sessionKey((await keyPair()).privateKey, hello.pub as string, id)
  stranger.send({ type: 'page-proof', ...(await seal(other, { nonce })) })
  stranger.send({ type: 'rpc', id: '1', ...(await seal(key, { method: 'GET', path: '/info' })) })
  stranger.send({ type: 'paired' })
  const heard = await Promise.race([
    stranger.next('bridge'),
    stranger.next('rpc-result'),
    new Promise((done) => setTimeout(() => done(null), 300)),
  ])
  assert.equal(heard, null)
  // The relay takes paired only after the CLI has sent the bridge.
  assert.equal(relay.sessions.get(id)?.paired, false)
  // The page the CLI opened, in its place, pairs.
  const opened = page(relay.origin, id)
  closeAtEnd(t, opened)
  const { bridge: got } = await opened.pair()
  assert.equal(got.secret, bridge.secret)
})

test('before pairing, a reloaded page pairs in place of the first, and a second CLI is refused', async (t) => {
  const id = makeId()
  const first = page(relay.origin, id)
  await first.opened
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
  })
  closeAtEnd(t, cli, first)
  await first.next('cli-joined')
  first.send({ type: 'page-hello', pub: (await keyPair()).pub })
  await first.next('cli-hello')
  const other = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
  })
  assert.equal((await other.closed).code, CLOSE.used)
  // The page reloads: a new page-hello, a new key, the same bridge.
  const reloaded = page(relay.origin, id)
  closeAtEnd(t, reloaded)
  const { bridge: got } = await reloaded.pair()
  assert.equal(got.secret, bridge.secret)
})

test('a paired CLI the relay drops rejoins with its token; closing it ends the session', async (t) => {
  const id = makeId()
  const p = page(relay.origin, id)
  const pairing = p.pair()
  const heard: boolean[] = []
  let cliPaired: () => void = () => {}
  const paired = new Promise<void>((done) => {
    cliPaired = done
  })
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
    delay: () => 50,
    onPaired: () => cliPaired(),
    onRelay: (back) => heard.push(back),
  })
  closeAtEnd(t, cli, p)
  const { key } = await pairing
  await paired
  // The relay cuts the CLI's socket (a deploy, the network): the CLI comes back by itself.
  relay.drop(id, 'cli')
  assert.equal((await p.next('cli-left')).type, 'cli-left')
  assert.equal((await p.next('cli-joined')).type, 'cli-joined')
  // The page's key still opens what the CLI seals: a relayed request is answered.
  p.send({ type: 'rpc', id: '1', ...(await seal(key, { method: 'GET', path: '/info' })) })
  const m = (await p.next('rpc-result')) as unknown as { iv: string; box: string }
  assert.equal((await unseal<{ status: number }>(key, m)).status, 200)
  assert.deepEqual(heard, [false, true])
  // Another CLI with a wrong token is still refused.
  const other = new WebSocket(`${relayUrl(relay.origin, id, 'cli')}&resume=${'f'.repeat(64)}`)
  const code = await new Promise((done) => other.addEventListener('close', (e) => done(e.code)))
  assert.equal(code, CLOSE.used)
  // Closing the CLI (Ctrl-C) closes with 1000: the session ends, and the page is told so.
  await cli.close()
  assert.equal(await p.closed, CLOSE.ended)
  assert.deepEqual(await cli.closed, { code: 1000, paired: true })
})

test('a page that reloads is not closed; one that does not come back is', async (t) => {
  const id = makeId()
  const heard: string[] = []
  const hear = async (n: number) => {
    for (let i = 0; i < 250 && heard.length < n; i++) await new Promise((r) => setTimeout(r, 20))
    return heard
  }
  const first = page(relay.origin, id)
  await first.opened
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
    // Long enough for a request under load, short enough for a test.
    pageBackMs: 1000,
    onPage: (state) => heard.push(state),
  })
  closeAtEnd(t, cli, first)
  await first.next('cli-joined')
  // Closed, and nothing comes back in time.
  first.ws.close()
  assert.deepEqual(await hear(1), ['closed'])
  // Before pairing, a reload says hello again in time.
  const second = page(relay.origin, id)
  closeAtEnd(t, second)
  await second.opened
  second.ws.close()
  await second.closed
  const third = page(relay.origin, id)
  closeAtEnd(t, third)
  const { bridge: got } = await third.pair()
  assert.deepEqual(await hear(2), ['closed', 'reloaded'])
  // Paired, a reload resumes without a hello: its request to the bridge is the page back.
  third.ws.close()
  await third.closed
  await new Promise((r) => setTimeout(r, 30))
  const info = await call(got.port, {
    path: '/info',
    headers: { Origin: SITE, Authorization: `Bearer ${got.secret}` },
  })
  assert.equal(info.status, 200)
  assert.deepEqual(await hear(3), ['closed', 'reloaded', 'reloaded'])
  // And no `closed` follows it.
  await new Promise((r) => setTimeout(r, 1200))
  assert.deepEqual(heard, ['closed', 'reloaded', 'reloaded'])
})

test('an id no CLI paired with in time is expired', async (t) => {
  const id = makeId()
  const p = page(relay.origin, id)
  closeAtEnd(t, p)
  await p.opened
  await new Promise((r) => setTimeout(r, 400))
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
  })
  closeAtEnd(t, cli)
  const end = await cli.closed
  assert.equal(end.code, CLOSE.expired)
  assert.equal(end.paired, false)
})

test('the bridge answers only the allowed origins carrying the secret', async () => {
  const info = (headers: Record<string, string>) => call(bridge.port, { path: '/info', headers })
  assert.equal((await info({})).status, 403)
  assert.equal((await info({ Authorization: `Bearer ${bridge.secret}` })).status, 403)
  assert.equal(
    (await info({ Origin: 'https://evil.example', Authorization: `Bearer ${bridge.secret}` }))
      .status,
    403,
  )
  assert.equal(
    (await info({ Origin: 'null', Authorization: `Bearer ${bridge.secret}` })).status,
    403,
  )
  assert.equal((await info({ Origin: SITE, Authorization: 'Bearer wrong' })).status, 403)
  assert.equal(
    (await info({ Origin: SITE, Authorization: `Bearer ${'0'.repeat(32)}` })).status,
    403,
  )
  const ok = await info(asPage(bridge))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['access-control-allow-origin'], SITE)
  assert.equal((await info(asPage(bridge, DEV))).status, 200)
  // EventSource's way: the secret in the query.
  assert.equal(
    (await call(bridge.port, { path: `/info?s=${bridge.secret}`, headers: { Origin: SITE } }))
      .status,
    200,
  )

  const preflight = (origin: string) =>
    call(bridge.port, {
      method: 'OPTIONS',
      path: '/render',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
  const allowed = await preflight(SITE)
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers['access-control-allow-private-network'], 'true')
  assert.match(String(allowed.headers['access-control-allow-headers']), /Authorization/)
  assert.equal((await preflight('https://evil.example')).status, 403)
})

test('/info reports the film, its variants and params, and telemetry', async () => {
  const info = jsonOf(await call(bridge.port, { path: '/info', headers: asPage(bridge) }))
  assert.match(info.version, /^\d+\.\d+\.\d+/)
  assert.equal(info.film.manifest.width, 16)
  assert.deepEqual(info.film.variants, {
    lighter: { label: 'a lighter grey', params: { grey: 100 } },
  })
  assert.deepEqual(Object.keys(info.film.schema.properties), ['grey'])
  assert.equal(typeof info.film.title, 'string')
  assert.equal(info.telemetry, true)
  process.env.SHADERERA_TELEMETRY = '0'
  try {
    const off = jsonOf(await call(bridge.port, { path: '/info', headers: asPage(bridge) }))
    assert.equal(off.telemetry, false)
  } finally {
    delete process.env.SHADERERA_TELEMETRY
  }
})

test('/events sends changed with the new revision when a project file changes', async () => {
  const sse = events(bridge)
  assert.equal(await sse.opened, 200)
  const file = join(root, 'src', 'composition.ts')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n// an edit\n`)
  const e = await sse.next((x) => x.type === 'changed')
  assert.equal(e.type === 'changed' && e.revision, treeId(scan(root)))
  // A file in out/ is no change: a revision never holds it.
  const before = sse.got.length
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', 'a render.txt'), 'x')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(sse.got.slice(before).filter((x) => x.type === 'changed').length, 0)
  sse.close()
})

test('/runner sends the frame to the runner page, served under a secret base only', async () => {
  const redirect = await call(bridge.port, {
    path: `/runner?s=${bridge.secret}&parent=${encodeURIComponent(SITE)}`,
  })
  assert.equal(redirect.status, 302)
  const location = new URL(String(redirect.headers.location))
  assert.equal(location.hostname, '127.0.0.1')
  assert.equal(location.searchParams.get('parent'), SITE)
  assert.equal(location.searchParams.get('s'), null)
  assert.match(location.pathname, /^\/runner\/[0-9a-f]{32}\/__shaderera\/runner\.html$/)
  // No secret, no runner.
  assert.equal((await call(bridge.port, { path: '/runner' })).status, 403)

  const runner = await fetch(location)
  assert.equal(runner.status, 200)
  assert.equal(runner.headers.get('access-control-allow-origin'), '*')
  const csp = runner.headers.get('content-security-policy') ?? ''
  assert.match(csp, new RegExp(`frame-ancestors ${SITE} ${DEV}(;|$)`))
  assert.match(csp, new RegExp(`script-src 'self' http://127.0.0.1:${location.port} `))
  assert.match(csp, /worker-src [^;]* data:/)
  const html = await runner.text()
  const base = location.pathname.replace(/__shaderera\/runner\.html$/, '')
  // The page's script and the worker's modules are under the base, as Vite serves them there.
  const script = new RegExp(`src="(${base}@fs/[^"]+bridge.ts)"`).exec(html)?.[1]
  assert.ok(script, html)
  const bridgeModule = await fetch(new URL(script, location))
  assert.equal(bridgeModule.status, 200)
  assert.equal(bridgeModule.headers.get('access-control-allow-origin'), '*')
  const worker = await fetch(new URL(script.replace(/bridge\.ts$/, 'worker.ts'), location))
  assert.equal(worker.status, 200)
  const workerCode = await worker.text()
  // The worker's own imports (its entry, the service token) stay under the base too.
  assert.ok(workerCode.includes(`import("${base}`), workerCode.match(/import\([^)]*\)/g)?.join(' '))
  assert.match(html, new RegExp(`<meta name="shaderera-parents" content="${SITE} ${DEV}">`))
  assert.match(
    html,
    new RegExp(`<meta name="shaderera-files" content="http://127.0.0.1:${location.port}/runner/`),
  )
  // Its files, under the base, to any origin; outside it, nothing.
  const manifest = await fetch(new URL(`${base}shaderera.json`, location))
  assert.equal(manifest.status, 200)
  assert.equal((await manifest.json()).width, 16)
  assert.equal((await fetch(new URL('/shaderera.json', location))).status, 403)
  assert.equal((await fetch(new URL('/__shaderera/runner.html', location))).status, 403)
})

const renderJob = async (body: unknown) => {
  const sse = events(bridge)
  await sse.opened
  const r = await call(bridge.port, {
    method: 'POST',
    path: '/render',
    headers: asPage(bridge),
    body,
  })
  assert.equal(r.status, 200, r.body.toString())
  const { job } = jsonOf(r)
  const end = await sse.next(
    (e) => e.type === 'job' && e.id === job && (e.state === 'done' || e.state === 'failed'),
  )
  sse.close()
  assert.equal(end.type === 'job' && end.state, 'done', JSON.stringify(end))
  return job as string
}

test('/render renders on this machine into out/, and /render/<job>/file streams it', async () => {
  const job = await renderJob({ format: 'png', variant: 'lighter', t: 0.5 })
  const file = await call(bridge.port, { path: `/render/${job}/file`, headers: asPage(bridge) })
  assert.equal(file.status, 200)
  assert.equal(file.headers['content-type'], 'image/png')
  assert.deepEqual([...file.body.subarray(1, 4)], [...Buffer.from('PNG')])
  assert.match(String(file.headers['content-disposition']), new RegExp(`-lighter-${job}\\.png`))
  assert.ok(existsSync(join(root, 'out', 'studio', `${basename(root)}-lighter-${job}.png`)))

  const bad = await call(bridge.port, {
    method: 'POST',
    path: '/render',
    headers: asPage(bridge),
    body: { format: 'gif' },
  })
  assert.equal(bad.status, 400)
  assert.equal(
    (await call(bridge.port, { path: '/render/abcdef/file', headers: asPage(bridge) })).status,
    404,
  )
})

test('/render/<job>/file names a file of a Thai project and a 16:9 variant, and the bridge lives on', async () => {
  const thai = fixture(join(tempDir('studio'), 'ภาพยนตร์'))
  const manifest = JSON.parse(readFileSync(join(thai, 'shaderera.json'), 'utf8'))
  manifest.variants['16:9'] = { params: { grey: 50 } }
  writeFileSync(join(thai, 'shaderera.json'), JSON.stringify(manifest))
  const b = await startBridge({ root: thai, api: SITE, site: SITE, origins: [SITE], settleMs: 50 })
  try {
    const sse = events(b)
    await sse.opened
    const r = await call(b.port, {
      method: 'POST',
      path: '/render',
      headers: asPage(b),
      body: { format: 'png', variant: '16:9' },
    })
    const { job } = jsonOf(r)
    const end = await sse.next(
      (e) => e.type === 'job' && e.id === job && (e.state === 'done' || e.state === 'failed'),
    )
    sse.close()
    assert.equal(end.type === 'job' && end.state, 'done', JSON.stringify(end))
    const name = `ภาพยนตร์-16_9-${job}.png`
    assert.ok(existsSync(join(thai, 'out', 'studio', name)))
    const file = await call(b.port, { path: `/render/${job}/file`, headers: asPage(b) })
    assert.equal(file.status, 200)
    const disposition = String(file.headers['content-disposition'])
    assert.equal(
      disposition,
      `attachment; filename="________-16_9-${job}.png"; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1] as string), name)
    // a name the format table only inherits is not a format
    for (const format of ['toString', 'constructor']) {
      const bad = await call(b.port, {
        method: 'POST',
        path: '/render',
        headers: asPage(b),
        body: { format },
      })
      assert.equal(bad.status, 400, format)
    }
    assert.equal((await call(b.port, { path: '/info', headers: asPage(b) })).status, 200)
  } finally {
    await b.close()
  }
})

test('a film in two ratios: /info gives their sizes, /runner frames each, /render does both', async () => {
  const two = fixture()
  const manifest = JSON.parse(readFileSync(join(two, 'shaderera.json'), 'utf8'))
  manifest.variants = {
    '16:9': { width: 32, height: 18 },
    '9:16': { width: 18, height: 32, duration: 0.5 },
  }
  writeFileSync(join(two, 'shaderera.json'), JSON.stringify(manifest))
  const b = await startBridge({ root: two, api: SITE, site: SITE, origins: [SITE], settleMs: 50 })
  try {
    const info = jsonOf(await call(b.port, { path: '/info', headers: asPage(b) }))
    assert.deepEqual(info.film.sizes, {
      '16:9': { width: 32, height: 18, duration: 1, fps: 10 },
      '9:16': { width: 18, height: 32, duration: 0.5, fps: 10 },
    })
    // The variants stay in shaderera.json's own shape.
    assert.deepEqual(info.film.variants, manifest.variants)

    // One frame a variant: the runner page gets the name, and the bridge knows every one.
    const runner = (variant: string) =>
      call(b.port, { path: `/runner?s=${b.secret}&variant=${encodeURIComponent(variant)}` })
    const framed = await runner('9:16')
    assert.equal(framed.status, 302)
    const location = new URL(String(framed.headers.location))
    assert.equal(location.searchParams.get('variant'), '9:16')
    assert.equal((await fetch(location)).status, 200)
    const unknown = await runner('4:5')
    assert.equal(unknown.status, 400)
    assert.match(jsonOf(unknown).error, /no variant "4:5"/)

    // Several variants at once: one job each, in the order asked.
    const sse = events(b)
    await sse.opened
    const asked = await call(b.port, {
      method: 'POST',
      path: '/render',
      headers: asPage(b),
      body: { format: 'png', variants: ['9:16', '16:9'], t: 0.25 },
    })
    assert.equal(asked.status, 200, asked.body.toString())
    const { jobs } = jsonOf(asked) as { jobs: string[] }
    assert.equal(jobs.length, 2)
    for (const job of jobs) {
      const end = await sse.next(
        (e) => e.type === 'job' && e.id === job && (e.state === 'done' || e.state === 'failed'),
      )
      assert.equal(end.type === 'job' && end.state, 'done', JSON.stringify(end))
    }
    sse.close()
    const sizes = []
    for (const [k, job] of jobs.entries()) {
      const name = `${basename(two)}-${k === 0 ? '9_16' : '16_9'}-${job}.png`
      const png = readFileSync(join(two, 'out', 'studio', name))
      sizes.push([png.readUInt32BE(16), png.readUInt32BE(20)])
    }
    assert.deepEqual(sizes, [
      [18, 32],
      [32, 18],
    ])

    // Every name is checked before a job is queued; variant and variants do not go together.
    for (const body of [
      { format: 'png', variants: ['16:9', '4:5'] },
      { format: 'png', variants: [] },
      { format: 'png', variants: '16:9' },
      { format: 'png', variant: '16:9', variants: ['9:16'] },
    ]) {
      const bad = await call(b.port, { method: 'POST', path: '/render', headers: asPage(b), body })
      assert.equal(bad.status, 400, JSON.stringify(body))
    }
  } finally {
    await b.close()
  }
})

test('/render makes an mp4 with ffmpeg', { skip: !ffmpeg && 'no ffmpeg' }, async () => {
  const job = await renderJob({ format: 'mp4', params: { grey: 200 } })
  const file = await call(bridge.port, { path: `/render/${job}/file`, headers: asPage(bridge) })
  assert.equal(file.status, 200)
  assert.equal(file.headers['content-type'], 'video/mp4')
  assert.equal(file.body.subarray(4, 8).toString(), 'ftyp')
})

test('/share without a login says how to log in', async () => {
  // A project that can be shared: its licence is checked before the token.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ license: 'MIT' }))
  const r = await call(bridge.port, {
    method: 'POST',
    path: '/share',
    headers: asPage(bridge),
    body: {},
  })
  assert.equal(r.status, 401)
  assert.deepEqual(jsonOf(r), { error: 'login', command: 'npx shaderera login' })
})

test('through the relay: sealed requests, sealed events and a file', async (t) => {
  const id = makeId()
  const p = page(relay.origin, id)
  const pairing = p.pair()
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
  })
  closeAtEnd(t, cli, p)
  const { key } = await pairing
  const rpc = async (rid: string, request: unknown) => {
    p.send({ type: 'rpc', id: rid, ...(await seal(key, request)) })
    const m = (await p.next('rpc-result')) as unknown as { id: string; iv: string; box: string }
    assert.equal(m.id, rid)
    return unseal<Record<string, unknown>>(key, m)
  }
  const info = await rpc('1', { method: 'GET', path: '/info' })
  assert.equal(info.status, 200)
  assert.deepEqual(Object.keys((info.body as { film: { variants: object } }).film.variants), [
    'lighter',
  ])
  const missing = await rpc('2', { method: 'GET', path: '/nowhere' })
  assert.equal(missing.status, 404)

  // Events follow through the relay once the page uses it.
  const file = join(root, 'src', 'composition.ts')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n// through the relay\n`)
  // Under load the bridge may still owe the `changed` of an earlier test's write (/share's
  // package.json); wait for the one with this edit's revision.
  const revision = treeId(scan(root))
  for (;;) {
    const m = (await p.next('event')) as unknown as { iv: string; box: string }
    const e = await unseal<StudioEvent>(key, m)
    if (e.type === 'changed' && e.revision === revision) break
  }

  const started = await rpc('3', {
    method: 'POST',
    path: '/render',
    body: { format: 'png', t: 0 },
  })
  const job = (started.body as { job: string }).job
  for (;;) {
    const e = await unseal<StudioEvent>(
      key,
      (await p.next('event')) as unknown as { iv: string; box: string },
    )
    if (e.type === 'job' && e.id === job && e.state === 'done') break
    assert.ok(!(e.type === 'job' && e.state === 'failed'), JSON.stringify(e))
  }
  const sent = await rpc('4', { method: 'GET', path: `/render/${job}/file` })
  assert.equal(sent.status, 200)
  assert.equal(sent.type, 'image/png')
  assert.match(String(sent.name), new RegExp(`-${job}\\.png$`))
  const bytes = Buffer.from(sent.base64 as string, 'base64')
  assert.deepEqual([...bytes.subarray(1, 4)], [...Buffer.from('PNG')])
})

test('telemetry: one notice, off by config or by SHADERERA_TELEMETRY=0', () => {
  const printed: string[] = []
  noticeOnce((t) => printed.push(t))
  noticeOnce((t) => printed.push(t))
  assert.ok(printed.length <= 1)
  assert.ok(!noticeOnce(() => {}))
  assert.match(NOTICE, /PostHog.*Never your code, file names, params, frames/s)
  assert.deepEqual(telemetryStatus(), { on: true, by: 'default' })
  setTelemetry(false)
  assert.deepEqual(telemetryStatus(), { on: false, by: 'config' })
  setTelemetry(true)
  process.env.SHADERERA_TELEMETRY = '0'
  try {
    assert.deepEqual(telemetryStatus(), { on: false, by: 'env' })
  } finally {
    delete process.env.SHADERERA_TELEMETRY
  }
  setTelemetry(true)
})

test('telemetry: a config that cannot be read is off, and is never overwritten', () => {
  const file = join(home, '.shaderera', 'config.json')
  const broken = '{ "telemetry": false, }\n'
  mkdirSync(join(home, '.shaderera'), { recursive: true })
  const was = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n'
  writeFileSync(file, broken)
  try {
    assert.deepEqual(telemetryStatus(), { on: false, by: 'config' })
    assert.ok(!noticeOnce(() => {}))
    assert.throws(() => setTelemetry(true), /cannot be read: fix it or delete it/)
    assert.equal(readFileSync(file, 'utf8'), broken)
  } finally {
    writeFileSync(file, was)
  }
})
