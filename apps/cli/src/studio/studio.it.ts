import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { saveToken } from '../cli/site.ts'
import { tempDir } from '../fixtures/temp.ts'
import { addressOf, call, nonce, page } from './fixtures/page.ts'
import { startRelay } from './fixtures/relay.ts'
import { keyPair, makeId, PROTOCOL } from './pairing.ts'

// The user's tokens (share) live in a home of the tests' own.
const home = tempDir('home')
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_TELEMETRY

const fixture = (root = tempDir('studio')) => {
  cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}
const jsonOf = (r: { body: Buffer }) => JSON.parse(r.body.toString('utf8'))

let relay: Awaited<ReturnType<typeof startRelay>>
before(async () => {
  relay = await startRelay({ ttlMs: 300 })
})
after(async () => {
  await relay.close()
})

test('shaderera studio --connect says so when the id expired', async () => {
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const start = (site: string, id: string) =>
    spawn(
      process.execPath,
      [main, 'studio', '--connect', id, '--site', site, '--no-open', '--root', fixture()],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    )
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

test("shaderera studio --api: Share sends films there, not to the studio page's site", async () => {
  // A films API of its own, the only one with a token: it records the calls and refuses them,
  // but for its health, which names the parents of its players.
  const seen: { path?: string; auth?: string }[] = []
  const films = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization })
    req.resume()
    if (req.url === '/api/v1/films/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ ok: true, parents: ['https://app.example', 'https://site.example'] }),
      )
      return
    }
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'the films site, as asked' }))
  })
  await new Promise<void>((done) => films.listen(0, '127.0.0.1', done))
  const address = films.address()
  const to = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  saveToken(to, 'films-token')
  // The CLI takes longer than the shared relay's 300 ms to start: a relay of its own.
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
      '--api',
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
  const pairing = addressOf(() => out, slow.origin, id).then((a) => {
    // The address the CLI prints: the page and the nonce in its fragment.
    assert.notEqual(a.nonce, nonce)
    return p.pair(a.nonce)
  })
  const exited = new Promise<number>((done) => cli.on('exit', (code) => done(code ?? -1)))
  try {
    const paired = await Promise.race([pairing, exited.then(() => null)])
    assert.ok(paired, out)
    // --connect pairs with the page: its bridge answers, and the CLI says so.
    const { bridge: got, hello } = paired
    assert.equal(hello.os, process.platform)
    const info = await call(got.port, {
      path: '/info',
      headers: { Origin: slow.origin, Authorization: `Bearer ${got.secret}` },
    })
    assert.equal(info.status, 200)
    for (let i = 0; i < 100 && !/paired/.test(out); i++) await new Promise((r) => setTimeout(r, 50))
    assert.match(out, /paired/)
    const r = await call(got.port, {
      method: 'POST',
      path: '/share',
      headers: { Origin: slow.origin, Authorization: `Bearer ${got.secret}` },
      body: {},
    })
    assert.equal(r.status, 500, out)
    assert.match(jsonOf(r).error, new RegExp(`on ${to}: 503 the films site, as asked`))
    assert.ok(seen.length > 0, 'the films site was called')
    assert.ok(seen.every((s) => s.path?.startsWith('/api/v1/')))
    // The token goes with the writes; the health is a read, without it.
    assert.ok(
      seen.every(
        (s) => s.auth === (s.path === '/api/v1/films/health' ? undefined : 'Bearer films-token'),
      ),
    )
    assert.match(out, new RegExp(`share to ${to}`))
    // The player was built for the parents the API names.
    assert.match(
      readFileSync(join(project, '.shaderera', 'player', 'runner.html'), 'utf8'),
      /name="shaderera-parents" content="https:\/\/app\.example https:\/\/site\.example"/,
    )
  } finally {
    cli.kill('SIGINT')
    await exited
    p.ws.close()
    await slow.close()
    films.close()
  }
})

test('shaderera studio --json: one JSON line per event, for an agent', async () => {
  const slow = await startRelay()
  const id = makeId()
  const p = page(slow.origin, id)
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const project = fixture()
  const cli = spawn(
    process.execPath,
    [
      main,
      'studio',
      '--connect',
      id,
      '--site',
      slow.origin,
      '--no-open',
      '--json',
      '--root',
      project,
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home } },
  )
  let out = ''
  let err = ''
  cli.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  cli.stderr.on('data', (d: Buffer) => {
    err += d.toString()
  })
  const exited = new Promise<number>((done) => cli.on('exit', (code) => done(code ?? -1)))
  const events = () =>
    out
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { event: string; [k: string]: unknown })
  const event = async (name: string) => {
    for (let i = 0; i < 400; i++) {
      const e = events().find((x) => x.event === name)
      if (e) return e
      if (cli.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`no ${name} event in: ${out}${err}`)
  }
  try {
    const url = await event('url')
    assert.equal(url.id, id)
    assert.equal(url.opened, false)
    assert.equal(url.site, slow.origin)
    const address = new URL(url.url as string)
    assert.equal(`${address.origin}${address.pathname}`, `${slow.origin}/studio/${id}`)
    await p.pair(address.hash.slice(1))
    await event('paired')
    // Nothing but events on stdout.
    assert.ok(events().every((e) => typeof e.event === 'string'))
    assert.equal(err, '')
  } finally {
    cli.kill('SIGINT')
    await exited
    p.ws.close()
    await slow.close()
  }
})

test('shaderera studio --json ends with an ended event when the id expired', async () => {
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const old = makeId()
  const gone = page(relay.origin, old)
  await gone.opened
  await new Promise((r) => setTimeout(r, 400))
  const late = spawn(
    process.execPath,
    [
      main,
      'studio',
      '--connect',
      old,
      '--site',
      relay.origin,
      '--no-open',
      '--json',
      '--root',
      fixture(),
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home } },
  )
  let out = ''
  late.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  assert.equal(await new Promise((done) => late.on('exit', done)), 2)
  const lines = out.split('\n').filter((line) => line.trim())
  const last = JSON.parse(lines.at(-1) as string)
  assert.equal(last.event, 'ended')
  assert.equal(last.exitCode, 2)
  assert.match(last.error, /expired/)
  gone.ws.close()
})

test("shaderera studio --json: the page's console comes as log events, without an extension's", async () => {
  const slow = await startRelay()
  const id = makeId()
  const p = page(slow.origin, id)
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
      '--no-open',
      '--json',
      '--root',
      fixture(),
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home } },
  )
  let out = ''
  let err = ''
  cli.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  cli.stderr.on('data', (d: Buffer) => {
    err += d.toString()
  })
  const exited = new Promise<number>((done) => cli.on('exit', (code) => done(code ?? -1)))
  // Every line on stdout is one JSON event: JSON.parse throws on any other.
  const events = () =>
    out
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { event: string; [k: string]: unknown })
  const event = async (match: (e: ReturnType<typeof events>[number]) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const e = events().find(match)
      if (e) return e
      if (cli.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`no such event in: ${out}${err}`)
  }
  let vite: WebSocket | undefined
  try {
    const url = await event((e) => e.event === 'url')
    const { bridge } = await p.pair(new URL(url.url as string).hash.slice(1))
    await event((e) => e.event === 'paired')
    // The runner the page frames, and its Vite client's socket, as the framed page opens it.
    const runner = await call(bridge.port, {
      path: '/runner',
      headers: { Origin: slow.origin, Authorization: `Bearer ${bridge.secret}` },
    })
    const at = new URL(String(runner.headers.location))
    const html = await (await fetch(at)).text()
    const src = /src="([^"]*@vite\/client)"/.exec(html)?.[1]
    assert.ok(src, 'the runner page loads the Vite client')
    const client = await (await fetch(new URL(src, at))).text()
    const token = /const wsToken = "([^"]+)"/.exec(client)?.[1]
    assert.ok(token, 'the Vite client holds its socket token')
    const base = src.slice(0, -'@vite/client'.length)
    vite = new WebSocket(`ws://${at.host}${base}?token=${token}`, 'vite-hmr')
    await new Promise((done, fail) => {
      vite?.addEventListener('open', done)
      vite?.addEventListener('error', fail)
    })
    const forward = (data: unknown) =>
      vite?.send(JSON.stringify({ type: 'custom', event: 'vite:forward-console', data }))
    // A browser extension's, in the page: MetaMask's warning and an uncaught error of its own.
    forward({
      type: 'log',
      data: {
        level: 'warn',
        message:
          'Error restoring session i: Failed to connect to MetaMask\n    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js:1:1)',
      },
    })
    forward({
      type: 'error',
      data: {
        name: 'Error',
        message: 'MetaMask: lost',
        stack:
          'Error: MetaMask: lost\n    at chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js:1:1',
      },
    })
    // The film's own.
    forward({ type: 'log', data: { level: 'warn', message: 'the film warns' } })
    const log = await event((e) => e.event === 'log' && /the film warns/.test(String(e.text)))
    assert.equal(log.level, 'warn')
    await new Promise((r) => setTimeout(r, 300))
    assert.doesNotMatch(out + err, /MetaMask|chrome-extension/)
    assert.equal(err, '')
  } finally {
    vite?.close()
    cli.kill('SIGINT')
    await exited
    p.ws.close()
    await slow.close()
  }
})

/** `shaderera studio --json --no-open` on a project, and its events as they come. */
const studioJson = (
  site: string,
  args: readonly string[] = [],
  o: { root?: string; stdin?: 'pipe' | 'ignore'; env?: NodeJS.ProcessEnv } = {},
) => {
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
  const cli = spawn(
    process.execPath,
    [main, 'studio', '--site', site, '--no-open', '--json', '--root', o.root ?? fixture(), ...args],
    // `ignore`: stdin is the null device, as an agent's shell gives a command.
    {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...o.env },
      stdio: [o.stdin ?? 'pipe', 'pipe', 'pipe'],
    },
  )
  let out = ''
  cli.stdout?.on('data', (d: Buffer) => {
    out += d.toString()
  })
  cli.stderr?.on('data', (d: Buffer) => {
    out += d.toString()
  })
  // 'close', not 'exit': stdout has been read to its end.
  const exited = new Promise<number>((done) => cli.on('close', (code) => done(code ?? -1)))
  const events = () =>
    out
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { event: string; [k: string]: unknown })
  const event = async (match: (e: ReturnType<typeof events>[number]) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const e = events().find(match)
      if (e) return e
      if (cli.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`no such event in: ${out}`)
  }
  return { cli, exited, events, event, out: () => out }
}

test('shaderera studio ends cleanly when its stdin closes or on a stop line', async () => {
  for (const stop of ['close', 'line'] as const) {
    const slow = await startRelay()
    const id = makeId()
    const p = page(slow.origin, id)
    const s = studioJson(slow.origin, ['--connect', id])
    try {
      const url = await s.event((e) => e.event === 'url')
      await p.pair(new URL(url.url as string).hash.slice(1))
      await s.event((e) => e.event === 'paired')
      if (stop === 'close') s.cli.stdin?.end()
      else s.cli.stdin?.write('{"stop":true}\n')
      assert.equal(await s.exited, 0, s.out())
      const last = s.events().at(-1)
      assert.deepEqual(last, { event: 'ended', exitCode: 0 }, stop)
      // The session ended at the relay: the page is told so.
      assert.equal(await p.closed, 4004, stop)
    } finally {
      s.cli.kill('SIGINT')
      await s.exited
      p.ws.close()
      await slow.close()
    }
  }
})

test('shaderera studio: an id no page came for gives a new id and url, and goes on', async () => {
  const short = await startRelay({ ttlMs: 1500, alarm: true })
  const s = studioJson(short.origin, [], { env: { SHADERERA_STUDIO_EXPIRY_MS: '1500' } })
  try {
    const first = await s.event((e) => e.event === 'url')
    const second = await s.event((e) => e.event === 'url' && e.id !== first.id)
    assert.equal(second.expired, first.id)
    assert.match(String(second.text), /No studio page came/)
    assert.equal(second.opened, false)
    assert.ok(!s.events().some((e) => e.event === 'ended'), s.out())
    // The new id pairs.
    const p = page(short.origin, second.id as string)
    await p.pair(new URL(second.url as string).hash.slice(1))
    await s.event((e) => e.event === 'paired')
    p.ws.close()
  } finally {
    s.cli.stdin?.end()
    await s.exited
    await short.close()
  }
})

test('shaderera studio: a page that leaves before pairing is no reload', async () => {
  const slow = await startRelay()
  const id = makeId()
  // A page that says hello and closes, then another that pairs.
  const first = page(slow.origin, id)
  await first.opened
  const s = studioJson(slow.origin, ['--connect', id])
  try {
    const url = await s.event((e) => e.event === 'url')
    await first.next('cli-joined')
    first.send({ type: 'page-hello', pub: (await keyPair()).pub, protocol: PROTOCOL })
    await first.next('cli-hello')
    first.ws.close()
    await first.closed
    await new Promise((r) => setTimeout(r, 200))
    const p = page(slow.origin, id)
    await p.pair(new URL(url.url as string).hash.slice(1))
    await s.event((e) => e.event === 'paired')
    await new Promise((r) => setTimeout(r, 200))
    const names = s.events().map((e) => e.event)
    assert.ok(!names.includes('resumed'), names.join(' '))
    assert.ok(!names.includes('page-closed'), names.join(' '))
    p.ws.close()
  } finally {
    s.cli.stdin?.end()
    await s.exited
    await slow.close()
  }
})

/** `shaderera studio --stop --root <root>`: its exit code and what it printed. */
const stopStudio = (root: string) =>
  new Promise<{ code: number; out: string }>((done) => {
    const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
    const c = spawn(process.execPath, [main, 'studio', '--stop', '--root', root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    let out = ''
    c.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    c.stderr.on('data', (d: Buffer) => {
      out += d.toString()
    })
    c.on('close', (code) => done({ code: code ?? -1, out }))
  })

test('shaderera studio --stop ends the running studio cleanly, with no stdin to reach', async () => {
  const slow = await startRelay()
  const id = makeId()
  const p = page(slow.origin, id)
  const root = fixture()
  const s = studioJson(slow.origin, ['--connect', id], { root, stdin: 'ignore' })
  const file = join(root, '.shaderera', 'studio', 'bridge.json')
  try {
    const url = await s.event((e) => e.event === 'url')
    await p.pair(new URL(url.url as string).hash.slice(1))
    await s.event((e) => e.event === 'paired')
    // The running studio is registered, for the user only.
    const running = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(running.pid, s.cli.pid)
    assert.equal(running.port, Number(new URL(url.bridge as string).port))
    if (process.platform === 'win32') {
      const acl = spawnSync('icacls', [file], { encoding: 'utf8' }).stdout
      assert.doesNotMatch(acl, /BUILTIN|Everyone|Authenticated Users/, acl)
    } else assert.equal(statSync(file).mode & 0o077, 0)

    // A second studio on the project is refused while this one runs.
    const second = studioJson(slow.origin, [], { root })
    assert.equal(await second.exited, 2)
    assert.match(second.out(), /studio --stop/)

    const stopped = await stopStudio(root)
    assert.equal(stopped.code, 0, stopped.out)
    assert.equal(await s.exited, 0, s.out())
    assert.deepEqual(s.events().at(-1), { event: 'ended', exitCode: 0 })
    assert.equal(await p.closed, 4004)
    assert.equal(existsSync(file), false)
  } finally {
    s.cli.kill('SIGINT')
    await s.exited
    p.ws.close()
    await slow.close()
  }
})

test('shaderera studio --stop removes a stale file, and says no studio runs', async () => {
  const root = fixture()
  // The pid of a process that has ended.
  const gone = spawn(process.execPath, ['-e', ''])
  await new Promise((r) => gone.on('close', r))
  const file = join(root, '.shaderera', 'studio', 'bridge.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ port: 9, secret: 'x'.repeat(32), pid: gone.pid }))
  const r = await stopStudio(root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /No studio is running/)
  assert.equal(existsSync(file), false)
})

test('shaderera studio: a relay that expires an id long before its limit ends it, once', async () => {
  // The relay expires ids after 300 ms; the CLI expects 1.5 s.
  const hasty = await startRelay({ ttlMs: 300, alarm: true })
  const s = studioJson(hasty.origin, [], { env: { SHADERERA_STUDIO_EXPIRY_MS: '1500' } })
  try {
    assert.equal(await s.exited, 2, s.out())
    assert.equal(s.events().filter((e) => e.event === 'url').length, 1)
    const last = s.events().at(-1)
    assert.equal(last?.event, 'ended')
    assert.match(String(last?.error), /expired studio session \w+ after 0\.\d s/)
  } finally {
    await hasty.close()
  }
})
