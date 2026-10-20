import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { saveToken } from '../cli/site.ts'
import { scan, treeId } from '../project/revisions.ts'
import { type Bridge, type StudioEvent, startBridge } from './bridge.ts'
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
const home = mkdtempSync(join(tmpdir(), 'shaderera-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_TELEMETRY

const SITE = 'https://shaderera.example'
/** The nonce the in-process CLIs pair with; the CLI makes one of its own each run. */
const nonce = makeNonce()
const DEV = 'http://localhost:3000'
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-studio-'))
  cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}

/** One request to the bridge, with the headers given (Node's fetch would not set Origin). */
const call = (
  port: number,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: o.method ?? 'GET',
        path: o.path,
        headers: {
          ...o.headers,
          ...(o.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (p: Buffer) => parts.push(p))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }),
        )
      },
    )
    req.on('error', fail)
    req.end(o.body === undefined ? undefined : JSON.stringify(o.body))
  })
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

/** The page's side of the relay, as the studio page does it, with WebCrypto. */
const page = (relay: string, id: string) => {
  const ws = new WebSocket(relayUrl(relay, id, 'page'))
  const inbox: { type: string; [k: string]: unknown }[] = []
  const waiting: { type: string; done: (m: (typeof inbox)[number]) => void }[] = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    const w = waiting.find((x) => x.type === m.type)
    if (w) {
      waiting.splice(waiting.indexOf(w), 1)
      w.done(m)
    } else inbox.push(m)
  })
  const next = (type: string) =>
    new Promise<(typeof inbox)[number]>((done) => {
      const at = inbox.findIndex((m) => m.type === type)
      if (at >= 0) done(inbox.splice(at, 1)[0] as (typeof inbox)[number])
      else waiting.push({ type, done })
    })
  const closed = new Promise<number>((done) => ws.addEventListener('close', (e) => done(e.code)))
  const opened = new Promise<void>((done) => ws.addEventListener('open', () => done()))
  return {
    ws,
    next,
    closed,
    opened,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    /**
     * page-hello now and on every cli-joined, then the proof of `proof`; resolves with the session
     * key and the bridge.
     */
    pair: async (proof = nonce) => {
      const mine = await keyPair()
      await opened
      ws.send(JSON.stringify({ type: 'page-hello', pub: mine.pub }))
      void next('cli-joined').then(() =>
        ws.send(JSON.stringify({ type: 'page-hello', pub: mine.pub })),
      )
      const hello = await next('cli-hello')
      const key = await sessionKey(mine.privateKey, hello.pub as string, id)
      ws.send(JSON.stringify({ type: 'page-proof', ...(await seal(key, { nonce: proof })) }))
      const sealed = (await next('bridge')) as unknown as { iv: string; box: string }
      const bridge = await unseal<{ port: number; secret: string }>(key, sealed)
      ws.send(JSON.stringify({ type: 'paired' }))
      return { key, hello, bridge }
    },
  }
}

/** The page address `shaderera studio --no-open` prints, once it has: `<site>/studio/<id>#<nonce>`. */
const addressOf = async (out: () => string, site: string, id: string) => {
  for (let i = 0; i < 400; i++) {
    const m = /^open +(\S+)$/m.exec(out())
    if (m) {
      const url = new URL(m[1] as string)
      assert.equal(`${url.origin}${url.pathname}${url.search}`, `${site}/studio/${id}?from=web`)
      return { nonce: url.hash.slice(1) }
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`no address in: ${out()}`)
}

let root: string
let bridge: Bridge
let relay: Awaited<ReturnType<typeof startRelay>>
before(async () => {
  root = fixture()
  bridge = await startBridge({ root, to: SITE, origins: [SITE, DEV], settleMs: 50 })
  relay = await startRelay({ ttlMs: 300 })
})
after(async () => {
  await bridge.close()
  await relay.close()
})

test('a studio session id is 20 characters of the alphabet', () => {
  for (let i = 0; i < 200; i++) assert.ok(isId(makeId()))
  assert.equal(makeId().length, 20)
  assert.equal(isId('abcdefghjkmnpqrstuv0'), false)
  assert.equal(isId('abcdef'), false)
  assert.equal(isId('abcdefghjkmnpqrstuvwx'), false)
  assert.match(makeNonce(), /^[\w-]{22}$/)
})

test('the CLI pairs through the relay, and only the page can open the bridge it sends', async () => {
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

test('a page without the nonce the CLI opened never gets the bridge or an answer', async () => {
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
  const { bridge: got } = await opened.pair()
  assert.equal(got.secret, bridge.secret)
  cli.close()
  opened.ws.close()
})

test('before pairing, a reloaded page pairs in place of the first, and a second CLI is refused', async () => {
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
  const { bridge: got } = await reloaded.pair()
  assert.equal(got.secret, bridge.secret)
  cli.close()
  first.ws.close()
  reloaded.ws.close()
})

test('an id no CLI paired with in time is expired', async () => {
  const id = makeId()
  const p = page(relay.origin, id)
  await p.opened
  await new Promise((r) => setTimeout(r, 400))
  const cli = connectRelay({
    site: relay.origin,
    id,
    nonce,
    bridge,
    hello: { version: '0', os: 'test', telemetry: true },
  })
  const end = await cli.closed
  assert.equal(end.code, CLOSE.expired)
  assert.equal(end.paired, false)
  p.ws.close()
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

test('/render makes an mp4 with ffmpeg', { skip: !ffmpeg && 'no ffmpeg' }, async () => {
  const job = await renderJob({ format: 'mp4', params: { grey: 200 } })
  const file = await call(bridge.port, { path: `/render/${job}/file`, headers: asPage(bridge) })
  assert.equal(file.status, 200)
  assert.equal(file.headers['content-type'], 'video/mp4')
  assert.equal(file.body.subarray(4, 8).toString(), 'ftyp')
})

test('/share without a login says how to log in', async () => {
  const r = await call(bridge.port, {
    method: 'POST',
    path: '/share',
    headers: asPage(bridge),
    body: {},
  })
  assert.equal(r.status, 401)
  assert.deepEqual(jsonOf(r), { error: 'login', command: 'npx shaderera login' })
})

test('through the relay: sealed requests, sealed events and a file', async () => {
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
  for (;;) {
    const m = (await p.next('event')) as unknown as { iv: string; box: string }
    const e = await unseal<StudioEvent>(key, m)
    if (e.type === 'changed') {
      assert.equal(e.revision, treeId(scan(root)))
      break
    }
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
  cli.close()
  p.ws.close()
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

test('shaderera studio --connect pairs with the page, and says so when the id expired', async () => {
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  // The CLI takes longer than the shared relay's 300 ms to start: a relay of its own.
  const slow = await startRelay()
  const start = (site: string, id: string) =>
    spawn(
      process.execPath,
      [main, 'studio', '--connect', id, '--site', site, '--no-open', '--root', fixture()],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    )
  const id = makeId()
  const p = page(slow.origin, id)
  const cli = start(slow.origin, id)
  let out = ''
  cli.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  cli.stderr.on('data', (d: Buffer) => {
    out += d.toString()
  })
  const exited = new Promise<number>((done) => cli.on('exit', (code) => done(code ?? -1)))
  const pairing = addressOf(() => out, slow.origin, id).then((address) => {
    // The address the CLI prints: the page and the nonce in its fragment.
    assert.notEqual(address.nonce, nonce)
    return p.pair(address.nonce)
  })
  const paired = await Promise.race([pairing, exited.then(() => null)])
  assert.ok(paired, out)
  const { bridge: got, hello } = paired
  assert.equal(hello.os, process.platform)
  const info = await call(got.port, {
    path: '/info',
    headers: { Origin: slow.origin, Authorization: `Bearer ${got.secret}` },
  })
  assert.equal(info.status, 200)
  for (let i = 0; i < 100 && !/paired/.test(out); i++) await new Promise((r) => setTimeout(r, 50))
  assert.match(out, /paired/)
  cli.kill('SIGINT')
  await exited
  p.ws.close()
  await slow.close()

  // An id whose page came and went long ago.
  const old = makeId()
  const gone = page(relay.origin, old)
  await gone.opened
  await new Promise((r) => setTimeout(r, 400))
  const late = start(relay.origin, old)
  let err = ''
  late.stderr.on('data', (d: Buffer) => {
    err += d.toString()
  })
  assert.equal(await new Promise((done) => late.on('exit', done)), 2)
  assert.match(err, /expired/)
  gone.ws.close()
})

test("shaderera studio --to: Share sends films there, not to the studio page's site", async () => {
  // A films site of its own, the only one with a token: it records the calls and refuses them.
  const seen: { path?: string; auth?: string }[] = []
  const films = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization })
    req.resume()
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'the films site, as asked' }))
  })
  await new Promise<void>((done) => films.listen(0, '127.0.0.1', done))
  const address = films.address()
  const to = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  saveToken(to, 'films-token')
  const slow = await startRelay()
  const id = makeId()
  const p = page(slow.origin, id)
  const project = fixture()
  writeFileSync(join(project, 'package.json'), JSON.stringify({ license: 'MIT' }))
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const cli = spawn(
    process.execPath,
    [
      main,
      'studio',
      '--connect',
      id,
      '--site',
      slow.origin,
      '--to',
      to,
      '--no-open',
      '--root',
      project,
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home } },
  )
  let out = ''
  cli.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  cli.stderr.on('data', (d: Buffer) => {
    out += d.toString()
  })
  const pairing = addressOf(() => out, slow.origin, id).then((a) => p.pair(a.nonce))
  const exited = new Promise<number>((done) => cli.on('exit', (code) => done(code ?? -1)))
  try {
    const paired = await Promise.race([pairing, exited.then(() => null)])
    assert.ok(paired, out)
    const { bridge: got } = paired
    const r = await call(got.port, {
      method: 'POST',
      path: '/share',
      headers: { Origin: slow.origin, Authorization: `Bearer ${got.secret}` },
      body: {},
    })
    assert.equal(r.status, 500, out)
    assert.match(jsonOf(r).error, new RegExp(`on ${to}: 503 the films site, as asked`))
    assert.ok(seen.length > 0, 'the films site was called')
    assert.ok(seen.every((s) => s.path?.startsWith('/api/v1/') && s.auth === 'Bearer films-token'))
    assert.match(out, new RegExp(`share to ${to}`))
  } finally {
    cli.kill('SIGINT')
    await exited
    p.ws.close()
    await slow.close()
    films.close()
  }
})
