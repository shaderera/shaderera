import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scan } from '../project/revisions.ts'
import { parseTarget } from './fork.ts'
import { send, shareFiles } from './share.ts'
import { siteOf } from './site.ts'

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/**
 * A fake of the site's API (`/api/v1`, the routes the POC app serves) in memory: films, versions
 * of path → sha256, and objects. It records every request, and can serve one object corrupted.
 */
const fakeSite = async () => {
  const TOKEN = 'tok-secret-123'
  const objects = new Map<string, Buffer>()
  type Version = {
    id: string
    licence: string
    files: Record<string, string>
    player: Record<string, string>
    shaderera: string
  }
  const films = new Map<
    string,
    { id: string; title: string; forkedFrom: string | null; versions: Version[] }
  >()
  const requests: { method: string; path: string; auth: string | undefined }[] = []
  const corrupt = new Set<string>()
  /** Like the app's API: a version needs a built player. */
  const options = { needsPlayer: false }
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const p of req) parts.push(p as Buffer)
    const body = Buffer.concat(parts)
    const path = (req.url ?? '').replace(/^\/api\/v1/, '')
    const method = req.method ?? ''
    requests.push({ method, path, auth: req.headers.authorization })
    const writes = method !== 'GET'
    if (writes && req.headers.authorization !== `Bearer ${TOKEN}`)
      return json(res, 401, { error: 'A token is needed.' })
    const obj = /^\/obj\/([0-9a-f]{64})$/.exec(path)
    const filmPath = /^\/films\/([a-z0-9]+)(\/versions)?$/.exec(path)
    const revision = /^\/versions\/([0-9a-f]{64})\/revision$/.exec(path)
    if (method === 'POST' && path === '/uploads/missing') {
      const { hashes } = JSON.parse(body.toString()) as { hashes: string[] }
      return json(res, 200, { missing: hashes.filter((h) => !objects.has(h)) })
    }
    if (obj) {
      const sha = obj[1] as string
      if (method === 'PUT') {
        if (sha256(body) !== sha) return json(res, 400, { error: 'Bad hash.' })
        objects.set(sha, body)
        res.writeHead(204).end()
        return
      }
      const o = objects.get(sha)
      if (!o) return json(res, 404, { error: 'No such object.' })
      res.writeHead(200).end(corrupt.has(sha) ? Buffer.from('not it') : o)
      return
    }
    if (method === 'POST' && path === '/films') {
      const b = JSON.parse(body.toString()) as { title: string; forkedFrom?: string }
      const id = `film${films.size + 1}`
      films.set(id, { id, title: b.title, forkedFrom: b.forkedFrom ?? null, versions: [] })
      return json(res, 201, { id })
    }
    if (filmPath) {
      const film = films.get(filmPath[1] as string)
      if (!film) return json(res, 404, { error: 'No such film.' })
      if (method === 'GET' && !filmPath[2])
        return json(res, 200, {
          id: film.id,
          title: film.title,
          owner: 'ana',
          forkedFrom: film.forkedFrom,
          latestVersion: film.versions.at(-1)?.id ?? null,
          versions: film.versions.map((x) => ({ id: x.id, licence: x.licence })),
        })
      const b = JSON.parse(body.toString()) as Omit<Version, 'id'>
      if (options.needsPlayer && Object.keys(b.player).length === 0)
        return json(res, 400, { error: 'A version needs its built player.' })
      const absent = [...Object.values(b.files), ...Object.values(b.player)].filter(
        (s) => !objects.has(s),
      )
      if (absent.length > 0) return json(res, 409, { error: 'Upload first.', missing: absent })
      const id = sha256(
        Object.keys(b.files)
          .sort()
          .map((p) => `${p}\t${b.files[p]}`)
          .join('\n'),
      )
      film.versions.push({ id, ...b })
      return json(res, 201, { version: id, url: `${site}/f/${film.id}` })
    }
    if (revision) {
      for (const f of films.values())
        for (const x of f.versions)
          if (x.id === revision[1]) return json(res, 200, { files: x.files })
      return json(res, 404, { error: 'No such version.' })
    }
    json(res, 404, { error: 'Not found.' })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => server.close())
  return { site, TOKEN, films, objects, requests, corrupt, options }
}

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const temp = (name: string) => mkdtempSync(join(tmpdir(), `shaderera-site-${name}-`))

/** Runs the CLI with its own home (where tokens are kept), from `cwd`. */
const cli = (home: string, cwd: string, ...args: string[]) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
    delete env.SHADERERA_SITE
    execFile(process.execPath, [main, ...args], { cwd, env }, (e, stdout, stderr) =>
      done({ status: e ? Number(e.code) : 0, stdout, stderr }),
    )
  })

/** A project with what a revision holds and what it never does, and a secret or two. */
const project = (licence: string | null = 'MIT') => {
  const root = temp('project')
  cpSync(fileURLToPath(new URL('./fixtures/mcp/', import.meta.url)), root, { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'neon-rain', ...(licence ? { license: licence } : {}) }),
  )
  writeFileSync(join(root, '.env'), 'API_KEY=never-sent')
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', '.npmrc'), '//registry/:_authToken=never-sent')
  for (const dir of ['out', 'node_modules/x', 'versions', '.shaderera']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'f.txt'), 'never sent')
  }
  return root
}

test('the site: https, or http on this machine only; a fork names a film, a version, or a page', () => {
  assert.equal(siteOf('https://example.com/some/page'), 'https://example.com')
  assert.equal(siteOf('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.throws(() => siteOf('http://example.com'), /https/)
  assert.equal(siteOf(undefined), process.env.SHADERERA_SITE ?? 'https://shaderera.com')
  assert.deepEqual(parseTarget('2phicdywpg', 'https://a.example'), {
    site: 'https://a.example',
    film: '2phicdywpg',
  })
  assert.deepEqual(parseTarget('https://b.example/t/2phicdywpg@ab12'), {
    site: 'https://b.example',
    film: '2phicdywpg',
    version: 'ab12',
  })
  assert.throws(() => parseTarget('../etc'), /Not a film/)
})

test('login keeps one token per site and never prints it', async () => {
  const home = temp('home')
  const r = await cli(home, home, 'login', '--token', 'tok-secret-123', '--to', 'https://a.example')
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout + r.stderr, /tok-secret-123/)
  await cli(home, home, 'login', '--token', 'other', '--to', 'https://b.example')
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.shaderera', 'tokens.json'), 'utf8')), {
    'https://a.example': 'tok-secret-123',
    'https://b.example': 'other',
  })
})

test('share sends what a revision holds less secrets, only with --yes off a terminal, and remembers the film', async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()

  const noToken = await cli(home, root, 'share', '--to', s.site, '--yes')
  assert.equal(noToken.status, 2)
  assert.match(noToken.stderr, /No token for/)
  await cli(home, root, 'login', '--token', s.TOKEN, '--to', s.site)

  const asked = await cli(home, root, 'share', '--to', s.site)
  assert.equal(asked.status, 2)
  assert.match(asked.stdout, /share: \d+ files, .* as a new film "neon-rain" \(licence MIT\)/)
  assert.match(asked.stdout, /not sent: \.env, sub\/\.npmrc/)
  assert.match(asked.stderr, /needs --yes/)
  assert.equal(s.requests.length, 0, 'nothing is sent before --yes')

  const r = await cli(home, root, 'share', '--to', s.site, '--yes', '--json')
  assert.equal(r.status, 0, r.stdout)
  const { result } = JSON.parse(r.stdout)
  assert.equal(result.film, 'film1')
  assert.equal(result.created, true)
  assert.deepEqual(result.notSent, ['.env', 'sub/.npmrc'])
  const sent = s.films.get('film1')?.versions[0]
  const expected = scan(root)
  delete expected['.env']
  delete expected['sub/.npmrc']
  assert.deepEqual(sent?.files, expected, "a revision's files, less secrets")
  assert.ok(Object.keys(expected).includes('shaderera.json'))
  assert.equal(result.uploaded, new Set(Object.values(expected)).size)
  for (const q of s.requests)
    assert.equal(q.auth, `Bearer ${s.TOKEN}`, `${q.method} ${q.path} carries the token`)
  assert.doesNotMatch(r.stdout, new RegExp(s.TOKEN))

  // Again: the same film; only a changed file is uploaded.
  writeFileSync(join(root, 'notes.txt'), 'a new file')
  const again = await cli(home, root, 'share', '--to', s.site, '--yes')
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /shared film film1 version [0-9a-f]{12}: 1 of \d+ files were new/)
  assert.equal(s.films.size, 1)
  assert.equal(s.films.get('film1')?.versions.length, 2)
})

test('share refuses a project that declares no licence, before anything is sent', async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project(null)
  await cli(home, root, 'login', '--token', s.TOKEN, '--to', s.site)
  const r = await cli(home, root, 'share', '--to', s.site, '--yes')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /declares no licence/)
  assert.equal(s.requests.length, 0)
})

test('fork copies a version into a new folder as a project, and its share is a new film forked from it', async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--to', s.site)
  assert.equal((await cli(home, root, 'share', '--to', s.site, '--yes')).status, 0)
  const shared = s.films.get('film1')?.versions[0]
  assert.ok(shared)

  const work = temp('work')
  const before = s.requests.length
  const r = await cli(home, work, 'fork', `${s.site}/f/film1`, 'mine', '--json')
  assert.equal(r.status, 0, r.stdout)
  const { result } = JSON.parse(r.stdout)
  assert.equal(result.version, shared.id)
  assert.equal(result.licence, 'MIT')
  const dir = join(work, 'mine')
  assert.deepEqual(scan(dir), shared.files, 'the version, exactly')
  assert.ok(!existsSync(join(dir, '.env')))
  for (const q of s.requests.slice(before)) assert.equal(q.auth, undefined, 'a fork sends no token')
  const note = JSON.parse(readFileSync(join(dir, '.shaderera', 'share.json'), 'utf8'))
  assert.deepEqual(note, { [s.site]: { forkedFrom: shared.id } })

  const full = await cli(home, work, 'fork', 'film1', 'mine', '--to', s.site)
  assert.equal(full.status, 2)
  assert.match(full.stderr, /is not empty/)

  const again = await cli(home, dir, 'share', '--to', s.site, '--yes')
  assert.equal(again.status, 0, again.stderr)
  assert.match(
    again.stdout,
    new RegExp(`a new film "neon-rain", forked from ${shared.id.slice(0, 12)}`),
  )
  assert.match(again.stdout, /shared film film2 /)
  assert.equal(s.films.get('film2')?.forkedFrom, shared.id)
})

test('fork writes nothing when a file does not match its sha256', async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--to', s.site)
  await cli(home, root, 'share', '--to', s.site, '--yes')
  const shared = s.films.get('film1')?.versions[0]
  s.corrupt.add(shared?.files['shaderera.json'] as string)
  const work = temp('work')
  const r = await cli(home, work, 'fork', 'film1', '--to', s.site)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /did not match its sha256/)
  assert.ok(!existsSync(join(work, 'film1')))

  // A version that names a path outside the folder is refused too.
  assert.ok(shared)
  shared.files['../escape.txt'] = shared.files['shaderera.json'] as string
  s.corrupt.clear()
  const bad = await cli(home, work, 'fork', 'film1', '--to', s.site)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /may not: \.\.\/escape\.txt/)
  rmSync(work, { recursive: true, force: true })
})

test('share sends no player until the engine builds one, and a site that needs one says so', async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--to', s.site)
  assert.equal((await cli(home, root, 'share', '--to', s.site, '--yes')).status, 0)
  assert.deepEqual(s.films.get('film1')?.versions[0]?.player, {})

  s.options.needsPlayer = true
  const r = await cli(home, root, 'share', '--to', s.site, '--yes')
  assert.equal(r.status, 2)
  assert.match(
    r.stderr,
    /POST \/films\/film1\/versions on .*: 400 A version needs its built player\./,
  )

  // A folder of built player files goes up as `player`, beside the source.
  const player = temp('player')
  mkdirSync(join(player, 'assets'))
  writeFileSync(join(player, 'runner.html'), '<!doctype html>')
  writeFileSync(join(player, 'assets', 'bridge.js'), 'export {}')
  const sent = await send({
    site: s.site,
    token: s.TOKEN,
    root,
    files: shareFiles(root).files,
    licence: 'MIT',
    title: 'neon-rain',
    film: 'film1',
    player,
  })
  const version = s.films.get('film1')?.versions.at(-1)
  assert.equal(version?.id, sent.version)
  assert.deepEqual(Object.keys(version?.player ?? {}).sort(), ['assets/bridge.js', 'runner.html'])
  assert.equal(sent.uploaded, 2, 'only the player was new')
})
