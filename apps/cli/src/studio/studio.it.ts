import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { saveToken } from '../cli/site.ts'
import { tempDir } from '../fixtures/temp.ts'
import { addressOf, call, nonce, page } from './fixtures/page.ts'
import { startRelay } from './fixtures/relay.ts'
import { makeId } from './pairing.ts'

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
