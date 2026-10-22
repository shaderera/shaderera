import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import {
  type Fixture,
  headerErrors,
  loadFixtures,
  matchRoute,
  requestErrors,
  responseErrors,
  shapeErrors,
} from './fixtures/api/contract.ts'
import { run as fork } from './fork.ts'
import { run as login } from './login.ts'
import { run as logout } from './logout.ts'
import { overLimits, send } from './share.ts'
import { call, healthOf, readToken, saveToken } from './site.ts'
import { run as whoami, whoIs } from './whoami.ts'

// The films API's contract (fixtures/api/README.md): a fake API that answers only from the
// fixtures, and the CLI's own client code (site.ts call and healthOf, login, whoami, logout,
// share's send, fork) run against it. Each request it sent must be the fixture's.

const home = tempDir('contract-home')
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_API
delete process.env.SHADERERA_SITE

const F = loadFixtures()
const fixture = (name: string): Fixture => {
  const f = F[name]
  if (!f) throw new Error(`no fixture ${name}`)
  return f
}
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

type Sent = {
  fixture: string
  method: string
  path: string
  headers: IncomingHttpHeaders
  raw: Buffer
  body?: unknown
}

/**
 * The films API as the named fixtures answer it, and nothing else: a request is answered by the
 * first of them whose route it is, else 404. It records each request and which fixture took it.
 */
const fakeApi = async (...names: string[]) => {
  const served = names.map(fixture)
  const sent: Sent[] = []
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const p of req) parts.push(p as Buffer)
    const raw = Buffer.concat(parts)
    const method = req.method ?? ''
    const path = (req.url ?? '').replace(/^\/api\/v1/, '')
    const f = served.find((x) => matchRoute(x.route, method, path))
    if (!f) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found.' }))
      return
    }
    const json = /json/.test(req.headers['content-type'] ?? '')
    sent.push({
      fixture: f.name,
      method,
      path,
      headers: req.headers,
      raw,
      ...(json ? { body: JSON.parse(raw.toString()) } : {}),
    })
    const { status, headers = {}, body, bytes } = f.response
    res.writeHead(
      status,
      Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== null)) as Record<
        string,
        string
      >,
    )
    res.end(body !== undefined ? JSON.stringify(body) : bytes)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  after(() => server.close())
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  /** Every request was one of the fixtures' and is shaped like it; their names, in order. */
  const check = (): string[] => {
    for (const q of sent) assert.deepEqual(requestErrors(fixture(q.fixture), q), [], q.fixture)
    return sent.map((q) => q.fixture)
  }
  return { api, sent, check }
}

/** Runs a command in this process, with what it printed. */
const quietly = async (go: () => Promise<number>) => {
  const out: string[] = []
  const log = console.log
  console.log = (...parts: unknown[]) => out.push(parts.map(String).join(' '))
  try {
    return { status: await go(), out: out.join('\n') }
  } finally {
    console.log = log
  }
}

const TOKEN = fixture('auth-github').response.body as { token: string }

test('every fixture is shaped like its own example, and its bytes hash to their path', () => {
  assert.ok(Object.keys(F).length > 0)
  for (const f of Object.values(F)) {
    const present = (h: Fixture['request']['headers'] = {}) =>
      Object.fromEntries(
        Object.entries(h)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => [k.toLowerCase(), v as string]),
      )
    const { method, path, headers, body } = f.request
    assert.deepEqual(
      requestErrors(f, { method, path, headers: present(headers), body }),
      [],
      f.name,
    )
    const answer = {
      status: f.response.status,
      headers: new Headers(present(f.response.headers)),
      body: f.response.body,
    }
    assert.deepEqual(responseErrors(f, answer), [], f.name)
    for (const m of [f.request, f.response])
      if (m.bytes !== undefined) {
        const sha = /\/obj\/([0-9a-f]{64})$/.exec(f.request.path)?.[1]
        assert.equal(sha256(m.bytes), sha, `${f.name}: its bytes are its path's object`)
      }
  }
})

test('a shape check finds a missing field, a wrong type and a bad record value, and lets v1 add', () => {
  const o = { records: ['x.files'], optional: ['x.url'] }
  const example = { id: 'a', n: 1, files: { 'a.ts': 'sha' }, list: [{ id: 'v' }], url: 'u' }
  assert.deepEqual(
    shapeErrors(example, { id: 'b', n: 2, files: {}, list: [], extra: true }, 'x', o),
    [],
  )
  assert.deepEqual(
    shapeErrors(example, { n: '2', files: { 'b.ts': 3 }, list: [{}], url: 'u' }, 'x', o),
    [
      'x.id: missing',
      'x.n: string, not number like 1',
      'x.files["b.ts"]: number, not string like "sha"',
      'x.list[].id: missing',
    ],
  )
  assert.deepEqual(
    headerErrors({ 'Retry-After': '60', Authorization: null }, { 'retry-after': 'soon' }, 'h'),
    ['h.Retry-After: soon, not a number'],
  )
})

test("the health's parents and upload limits are what share builds for and checks; read without a token", async () => {
  const s = await fakeApi('health')
  const { parents, limits } = fixture('health').response.body as {
    parents: string[]
    limits: Record<string, number>
  }
  const read = await healthOf(s.api)
  assert.deepEqual(read.parents, parents)
  assert.equal(read.error, undefined)
  // Every upload limit share checks before it uploads, as the API names it (the hourly ones are
  // the API's to enforce).
  const upload = ['fileBytes', 'versionBytes', 'filesPerVersion', 'hashesPerAsk']
  for (const k of [...upload, 'posterBytes', 'loopBytes'])
    assert.equal(read.limits[k as keyof typeof read.limits], limits[k], k)
  assert.deepEqual(s.check(), ['health'])

  // A version over them is refused before anything is sent.
  const file = (bytes: number) => ({ path: 'a.bin', sha: 'a'.repeat(64), bytes })
  const fits = { objects: [file(limits.fileBytes as number)], files: 1, poster: null, loop: null }
  assert.deepEqual(overLimits(read.limits, fits), [])
  const over = overLimits(read.limits, {
    objects: [file((limits.fileBytes as number) + 1)],
    files: (limits.filesPerVersion as number) + 1,
    poster: { path: 'poster.webp', sha: 'b'.repeat(64), bytes: (limits.posterBytes as number) + 1 },
    loop: { path: 'loop.mp4', sha: 'c'.repeat(64), bytes: (limits.loopBytes as number) + 1 },
  })
  assert.equal(over.length, 4, over.join('\n'))
})

test('login swaps the GitHub token at /auth/github and keeps the token the API answers', async () => {
  const github = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify(
        req.url === '/device'
          ? {
              device_code: 'dev-1',
              user_code: 'WDJB-MJHT',
              verification_uri: 'https://github.com/login/device',
              interval: 0,
            }
          : { access_token: 'gho_from-github', token_type: 'bearer', scope: '' },
      ),
    )
  })
  await new Promise<void>((done) => github.listen(0, '127.0.0.1', done))
  after(() => github.close())
  const origin = `http://127.0.0.1:${(github.address() as AddressInfo).port}`
  const s = await fakeApi('auth-github')
  const r = await quietly(() =>
    login(['--api', s.api, '--no-open'], {
      github: { deviceCode: `${origin}/device`, accessToken: `${origin}/token` },
      clientId: 'Ov23-test',
      open: () => {},
      sleep: async () => {},
      machine: () => 'studio-mac',
    }),
  )
  assert.equal(r.status, 0)
  assert.deepEqual(s.check(), ['auth-github'])
  assert.deepEqual(s.sent[0]?.body, { token: 'gho_from-github', name: 'studio-mac' })
  assert.equal(readToken(s.api), TOKEN.token)
  assert.match(r.out, /Signed in as ana .*"studio-mac", until 2027-01-03/)
})

test('whoami reads /auth/me; a 401 there is a token no longer signed in', async () => {
  const s = await fakeApi('auth-me')
  saveToken(s.api, TOKEN.token)
  assert.deepEqual(await whoIs(s.api), fixture('auth-me').response.body)
  assert.deepEqual(s.check(), ['auth-me'])

  const out = await fakeApi('error-401')
  saveToken(out.api, 'sha_signed-out-elsewhere')
  const r = await quietly(() => whoami(['--api', out.api]))
  assert.equal(r.status, 1)
  assert.match(r.out, /The token here is no longer signed in to .* Sign in: npx shaderera login/)
  assert.deepEqual(out.check(), ['error-401'])
})

test('logout posts no body; logout --all posts { all: true }', async () => {
  const one = await fakeApi('auth-logout')
  saveToken(one.api, TOKEN.token)
  assert.equal((await quietly(() => logout(['--api', one.api]))).status, 0)
  assert.deepEqual(one.check(), ['auth-logout'])
  assert.equal(one.sent[0]?.raw.length, 0)
  assert.equal(readToken(one.api), undefined)

  const all = await fakeApi('auth-logout-all')
  saveToken(all.api, TOKEN.token)
  assert.equal((await quietly(() => logout(['--api', all.api, '--all']))).status, 0)
  assert.deepEqual(all.check(), ['auth-logout-all'])
})

/**
 * A project of the fixtures' film: the source (shaderera.json) and a built player (runner.html),
 * whose bytes are the ones the fixtures upload and fork, and a poster and a loop.
 */
const film = () => {
  const root = tempDir('contract-film')
  const source = fixture('obj-get').response.bytes as string
  writeFileSync(join(root, 'shaderera.json'), source)
  const player = join(root, '.shaderera', 'player')
  mkdirSync(join(player, 'files'), { recursive: true })
  writeFileSync(join(player, 'runner.html'), fixture('obj-put').request.bytes as string)
  writeFileSync(join(player, 'files', 'shaderera.json'), source)
  writeFileSync(join(root, 'poster.webp'), 'RIFF....WEBP')
  writeFileSync(join(root, 'loop.mp4'), '....ftypisom')
  return {
    root,
    player,
    files: { 'shaderera.json': sha256(source) },
    media: { poster: join(root, 'poster.webp'), loop: join(root, 'loop.mp4') },
  }
}

test('share asks what is missing, uploads it, makes the film and publishes the version', async () => {
  const s = await fakeApi('uploads-missing', 'obj-put', 'films-create', 'versions-publish')
  const p = film()
  const sent = await send({
    api: s.api,
    site: 'https://shaderera.com',
    token: TOKEN.token,
    root: p.root,
    files: p.files,
    licence: 'MIT',
    title: 'neon-rain',
    player: p.player,
    media: p.media,
  })
  assert.deepEqual(s.check(), ['uploads-missing', 'obj-put', 'films-create', 'versions-publish'])
  const put = s.sent[1] as Sent
  assert.equal(put.raw.toString(), fixture('obj-put').request.bytes, 'the missing object, as is')
  const made = fixture('versions-publish').response.body as Record<string, string>
  assert.equal(sent.film, (fixture('films-create').response.body as { id: string }).id)
  assert.equal(sent.version, made.version)
  assert.equal(sent.url, made.page, "the film's page, never the runner")
  const body = s.sent[3]?.body as Record<string, unknown>
  assert.equal(body.poster, sha256(readFileSync(p.media.poster)))
  assert.equal(body.loop, sha256(readFileSync(p.media.loop)))
})

test("a fork's first share makes a film forked from its version", async () => {
  const s = await fakeApi('uploads-missing', 'obj-put', 'films-create-forked', 'versions-publish')
  const p = film()
  const { forkedFrom } = fixture('films-create-forked').request.body as { forkedFrom: string }
  await send({
    api: s.api,
    site: 'https://shaderera.com',
    token: TOKEN.token,
    root: p.root,
    files: p.files,
    licence: 'MIT',
    title: 'neon-rain',
    forkedFrom,
    player: p.player,
  })
  assert.deepEqual(s.check(), [
    'uploads-missing',
    'obj-put',
    'films-create-forked',
    'versions-publish',
  ])
  assert.deepEqual(s.sent[2]?.body, { title: 'neon-rain', forkedFrom })
})

test('fork reads the film, its revision and each object, without a token', async () => {
  const s = await fakeApi('film-get', 'revision-get', 'obj-get')
  const into = join(tempDir('contract-fork'), 'neon-rain')
  const { id } = fixture('film-get').response.body as { id: string }
  const r = await quietly(() => fork([id, into, '--api', s.api, '--json']))
  assert.equal(r.status, 0)
  assert.deepEqual(s.check(), ['film-get', 'revision-get', 'obj-get'])
  assert.equal(
    readFileSync(join(into, 'shaderera.json'), 'utf8'),
    fixture('obj-get').response.bytes,
  )
})

test("an error names the call, its status and the API's sentence; a 429 says when to retry", async () => {
  const big = await fakeApi('error-413')
  const f413 = fixture('error-413')
  await assert.rejects(
    call(big.api, 'PUT', f413.request.path, { token: TOKEN.token, bytes: new Uint8Array(8) }),
    /PUT \/obj\/[0-9a-f]{64} on .*: 413 A file is at most 5 MiB\.$/,
  )
  big.check()

  const busy = await fakeApi('uploads-missing', 'obj-put', 'error-429')
  const p = film()
  await assert.rejects(
    send({
      api: busy.api,
      site: 'https://shaderera.com',
      token: TOKEN.token,
      root: p.root,
      files: p.files,
      licence: 'MIT',
      title: 'neon-rain',
      film: '2phicdywpg',
      player: p.player,
    }),
    /: 429 Over 20 publishes an hour\. Try again in 1800 s\.$/,
  )
  assert.deepEqual(busy.check(), ['uploads-missing', 'obj-put', 'error-429'])
})

test('a 426 names the version the API needs', async () => {
  const old = await fakeApi('error-426')
  const { minimum } = fixture('error-426').response.body as { minimum: string }
  await assert.rejects(
    call(old.api, 'POST', '/uploads/missing', { token: TOKEN.token, json: { hashes: [] } }),
    (e: Error) => e.message.includes(': 426 ') && e.message.includes(`update to ${minimum}`),
  )
})

test('every request names the CLI and its version: User-Agent shaderera/<version>', {
  todo: 'site.ts call() and healthOf() send no User-Agent yet (#214)',
}, async () => {
  const s = await fakeApi('health', 'auth-me')
  saveToken(s.api, TOKEN.token)
  await healthOf(s.api)
  await whoIs(s.api)
  for (const q of s.sent) assert.match(q.headers['user-agent'] ?? '', /^shaderera\/\d+\.\d+\.\d+/)
})
