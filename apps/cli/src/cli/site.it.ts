import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { ffmpeg, footageProject } from '../player/fixtures/make.ts'
import { hashFile, scan } from '../project/revisions.ts'
import { probe } from './ffmpeg.ts'
import { LOOP, mediaDir, POSTER } from './media.ts'
import { playerDir, playerFiles } from './share.ts'

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
/** A version's host label, as the films API spells it (ADR 0024): its sha256 in base32. */
const label = (hex: string) =>
  [...Buffer.from(hex, 'hex')]
    .map((b) => b.toString(2).padStart(8, '0'))
    .join('')
    .padEnd(260, '0')
    .replace(/.{5}/g, (c) => 'abcdefghijklmnopqrstuvwxyz234567'[Number.parseInt(c, 2)] ?? '')

/**
 * A fake of the films API (`/api/v1`, the routes the films app serves) in memory: films, versions
 * of path → sha256, and objects. It records every request, and can serve one object corrupted.
 * Its health names `options.parents` (null: an older API, without the field) and
 * `options.limits`, which its routes enforce as the API's do (hashes an ask, bytes a file).
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
    poster?: string
    loop?: string
  }
  const films = new Map<
    string,
    { id: string; title: string; forkedFrom: string | null; versions: Version[] }
  >()
  const requests: {
    method: string
    path: string
    auth: string | undefined
    agent: string | undefined
  }[] = []
  const corrupt = new Set<string>()
  /** Like the app's API: a version needs a built player; its response has the film's `page`. */
  const options = {
    needsPlayer: false,
    page: true,
    parents: null as unknown,
    /** How the health answers: as the API does, or a proxy's HTML page. */
    health: 'json' as 'json' | 'html',
    limits: {} as { fileBytes?: number; hashesPerAsk?: number; filesPerVersion?: number },
  }
  const asks: number[] = []
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
    requests.push({
      method,
      path,
      auth: req.headers.authorization,
      agent: req.headers['user-agent'],
    })
    const writes = method !== 'GET'
    if (writes && req.headers.authorization !== `Bearer ${TOKEN}`)
      return json(res, 401, { error: 'A token is needed.' })
    const obj = /^\/obj\/([0-9a-f]{64})$/.exec(path)
    const filmPath = /^\/films\/([a-z0-9]+)(\/versions)?$/.exec(path)
    const revision = /^\/versions\/([0-9a-f]{64})\/revision$/.exec(path)
    if (method === 'GET' && path === '/films/health' && options.health === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html>\n<html><body>a proxy page</body></html>')
      return
    }
    if (method === 'GET' && path === '/films/health')
      return json(res, 200, {
        ok: true,
        service: 'web',
        ...(options.parents === null ? {} : { parents: options.parents }),
        limits: options.limits,
      })
    if (method === 'POST' && path === '/uploads/missing') {
      const { hashes } = JSON.parse(body.toString()) as { hashes: string[] }
      asks.push(hashes.length)
      if (options.limits.hashesPerAsk !== undefined && hashes.length > options.limits.hashesPerAsk)
        return json(res, 400, { error: 'Too many hashes.' })
      return json(res, 200, { missing: hashes.filter((h) => !objects.has(h)) })
    }
    if (obj) {
      const sha = obj[1] as string
      if (method === 'PUT') {
        if (sha256(body) !== sha) return json(res, 400, { error: 'Bad hash.' })
        if (options.limits.fileBytes !== undefined && body.length > options.limits.fileBytes)
          return json(res, 413, { error: 'The file is over its limit.' })
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
      const absent = [
        ...Object.values(b.files),
        ...Object.values(b.player),
        ...[b.poster, b.loop].filter((x) => x !== undefined),
      ].filter((s) => !objects.has(s))
      if (absent.length > 0) return json(res, 409, { error: 'Upload first.', missing: absent })
      const id = sha256(
        Object.keys(b.files)
          .sort()
          .map((p) => `${p}\t${b.files[p]}`)
          .join('\n'),
      )
      film.versions.push({ id, ...b })
      // As the films API answers: `url` is the version's runner, `page` the canvas with the film.
      return json(res, 201, {
        version: id,
        url: `http://${label(id)}.localhost:${(server.address() as AddressInfo).port}/runner.html`,
        ...(options.page ? { page: `${site}/film/${film.id}` } : {}),
      })
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
  return { site, TOKEN, films, objects, requests, corrupt, options, asks }
}

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const temp = (name: string) => tempDir(`site-${name}`)

/** Runs the CLI with its own home (where tokens are kept), from `cwd`. */
const cli = (home: string, cwd: string, ...args: string[]) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
    delete env.SHADERERA_SITE
    delete env.SHADERERA_API
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

test('login keeps one token per API and never prints it', async () => {
  const home = temp('home')
  const r = await cli(
    home,
    home,
    'login',
    '--token',
    'tok-secret-123',
    '--api',
    'https://a.example',
  )
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout + r.stderr, /tok-secret-123/)
  await cli(home, home, 'login', '--token', 'other', '--api', 'https://b.example')
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.shaderera', 'tokens.json'), 'utf8')), {
    'https://a.example': 'tok-secret-123',
    'https://b.example': 'other',
  })
})

test('share sends what a revision holds less secrets and its built player, only with --yes off a terminal, and remembers the film', async () => {
  const s = await fakeSite()
  s.options.needsPlayer = true
  const home = temp('home')
  const root = project()

  const noToken = await cli(home, root, 'share', '--api', s.site, '--yes')
  assert.equal(noToken.status, 2)
  assert.match(noToken.stderr, /No token for/)
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)

  const asked = await cli(home, root, 'share', '--api', s.site)
  assert.equal(asked.status, 2)
  assert.match(asked.stdout, /share: \d+ files, .* as a new film "neon-rain" \(licence MIT\)/)
  assert.match(asked.stdout, /not sent: \.env, sub\/\.npmrc/)
  assert.match(asked.stderr, /needs --yes/)
  // Only the health is read (the player's parents), before the build, and without the token.
  assert.deepEqual(
    s.requests.map((q) => `${q.method} ${q.path} ${q.auth ?? 'no token'}`),
    ['GET /films/health no token'],
    'nothing is sent before --yes',
  )

  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media', '--json')
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
  // Every object once: the source's, the player's (whose files/ are the same objects), the media.
  const objects = new Set([
    ...Object.values(expected),
    ...Object.values(sent?.player ?? {}),
    ...[sent?.poster, sent?.loop].filter((x) => x !== undefined),
  ])
  assert.equal(result.uploaded, objects.size)
  for (const q of s.requests.filter((q) => q.path !== '/films/health'))
    assert.equal(q.auth, `Bearer ${s.TOKEN}`, `${q.method} ${q.path} carries the token`)
  assert.doesNotMatch(r.stdout, new RegExp(s.TOKEN))
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  for (const q of s.requests)
    assert.equal(q.agent, `shaderera/${version}`, `${q.method} ${q.path} names the CLI`)

  // The player, built into .shaderera/player and sent beside the source.
  assert.ok(sent)
  const player = playerFiles(playerDir(root))
  assert.deepEqual(sent.player, player, 'the built player, as built')
  for (const f of ['runner.html', 'assets/bridge.js', 'assets/worker.js'])
    assert.ok(sent.player[f], `${f} in the player`)
  assert.deepEqual(result.player.files, Object.keys(player).length)
  assert.ok(result.player.bytes > 0)
  // The film's files ride in the player too, as the source sends them; the player is no source.
  for (const [p, sha] of Object.entries(sent.files)) assert.equal(sent.player[`files/${p}`], sha)
  assert.ok(!Object.keys(sent.files).some((p) => p.startsWith('.shaderera/')))
  for (const sha of Object.values(sent.player)) assert.ok(s.objects.has(sha))
  // The API names no parents: only the site's pages may frame it.
  assert.deepEqual(result.parents, ['https://shaderera.com'])
  assert.match(
    readFileSync(join(playerDir(root), 'runner.html'), 'utf8'),
    /name="shaderera-parents" content="https:\/\/shaderera\.com"/,
  )

  // Again: the same film; only a changed file is uploaded.
  writeFileSync(join(root, 'notes.txt'), 'a new file')
  const again = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /shared film film1 version [0-9a-f]{12}: 1 of \d+ files were new/)
  assert.equal(s.films.size, 1)
  assert.equal(s.films.get('film1')?.versions.length, 2)
})

test('share refuses a project that declares no licence, before anything is sent and before the token', async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project(null)
  // Not signed in: the licence is what it says first.
  const first = await cli(home, root, 'share', '--api', s.site, '--yes')
  assert.equal(first.status, 2)
  assert.match(first.stderr, /declares no licence/)
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const r = await cli(home, root, 'share', '--api', s.site, '--yes')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /declares no licence/)
  assert.equal(s.requests.length, 0)
})

test('share --dry-run needs no token, builds the player, and sends nothing', async () => {
  const s = await fakeSite()
  s.options.limits = { fileBytes: 5 * 1024 * 1024, filesPerVersion: 2000 }
  const home = temp('home')
  const root = project()
  const r = await cli(home, root, 'share', '--api', s.site, '--dry-run', '--no-media', '--json')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const { result } = JSON.parse(r.stdout)
  assert.equal(result.dryRun, true)
  assert.equal(result.signedIn, false)
  assert.equal(result.film, null)
  assert.equal(result.title, 'neon-rain')
  assert.equal(result.licence, 'MIT')
  assert.ok(result.files > 0 && result.bytes > 0)
  assert.ok(result.player.files > 0, 'the player was built')
  assert.ok(existsSync(join(playerDir(root), 'runner.html')))
  assert.deepEqual(result.notSent, ['.env', 'sub/.npmrc'])
  assert.deepEqual(result.limits, s.options.limits)
  assert.deepEqual(result.over, [])
  assert.equal(result.poster, null)
  assert.deepEqual(
    s.requests.map((q) => `${q.method} ${q.path} ${q.auth ?? 'no token'}`),
    ['GET /films/health no token'],
    'only the health is read',
  )

  const said = await cli(home, root, 'share', '--api', s.site, '--dry-run', '--no-media')
  assert.equal(said.status, 0, said.stderr)
  assert.match(
    said.stdout,
    /^share: \d+ files, .* to http:\/\/127\.0\.0\.1:\d+ as a new film "neon-rain"/m,
  )
  assert.match(said.stdout, /not signed in to \S+; sign in: npx shaderera login --api/)
  assert.match(said.stdout, /Nothing was sent \(--dry-run\)\.\n$/)
})

test("a version over the API's limits is refused before anything is uploaded; --dry-run names them", async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(3000, 1))
  s.options.limits = { fileBytes: 2000, filesPerVersion: 3 }
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(
    r.stderr,
    new RegExp(
      `Over the limits of ${s.site}: .*big\\.bin is 3 KB, over the 2 KB a file may be; .*the version has \\d+ files \\(source and player\\), over the 3 a version may have\\. Nothing was sent\\.`,
    ),
  )
  assert.deepEqual(
    s.requests.map((q) => q.path),
    ['/films/health'],
    'nothing was uploaded',
  )

  const dry = await cli(home, root, 'share', '--api', s.site, '--dry-run', '--no-media', '--json')
  assert.equal(dry.status, 1, 'a dry run over a limit exits 1')
  const { result } = JSON.parse(dry.stdout)
  assert.equal(result.signedIn, true)
  assert.ok(result.over.some((o: string) => /^big\.bin is 3 KB/.test(o)))
})

test('share asks which objects are missing in batches no larger than the API takes', async () => {
  const s = await fakeSite()
  s.options.limits = { hashesPerAsk: 3 }
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media', '--json')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(s.asks.length > 1, `${s.asks.length} asks`)
  assert.ok(s.asks.every((n) => n <= 3))
  assert.equal(JSON.parse(r.stdout).result.uploaded, s.objects.size)
})

test('share passes --host to the poster and loop render', {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  const r = await cli(home, root, 'share', '--api', s.site, '--dry-run', '--host', 'nonsense')
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /The film did not render: --host is node or browser, not nonsense\./)
})

test('fork copies a version into a new folder as a project, and its share is a new film forked from it', async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  assert.equal((await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')).status, 0)
  const shared = s.films.get('film1')?.versions[0]
  assert.ok(shared)

  const work = temp('work')
  const before = s.requests.length
  // The API's address names the film; a page of another origin is not looked up on it.
  const elsewhere = await cli(
    home,
    work,
    'fork',
    'https://other.example/film/film1',
    '--api',
    s.site,
  )
  assert.equal(elsewhere.status, 2)
  assert.match(elsewhere.stderr, /is not the site \(https:\/\/shaderera\.com\) nor the films API/)
  const r = await cli(home, work, 'fork', `${s.site}/film/film1`, 'mine', '--api', s.site, '--json')
  assert.equal(r.status, 0, r.stdout)
  const { result } = JSON.parse(r.stdout)
  assert.equal(result.version, shared.id)
  assert.equal(result.licence, 'MIT')
  const dir = join(work, 'mine')
  // The version, exactly, but for where it came from: package.json's forkedFrom and a README line.
  const { 'package.json': _p, 'README.md': _r, ...rest } = shared.files
  const { 'package.json': _fp, 'README.md': _fr, ...forked } = scan(dir)
  assert.deepEqual(forked, rest)
  assert.equal(result.forkedFrom.version, shared.id)
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).forkedFrom.version,
    shared.id,
  )
  assert.ok(!existsSync(join(dir, '.env')))
  for (const q of s.requests.slice(before)) assert.equal(q.auth, undefined, 'a fork sends no token')
  const note = JSON.parse(readFileSync(join(dir, '.shaderera', 'share.json'), 'utf8'))
  assert.deepEqual(note, { [s.site]: { forkedFrom: shared.id } })

  const full = await cli(home, work, 'fork', 'film1', 'mine', '--api', s.site)
  assert.equal(full.status, 2)
  assert.match(full.stderr, /is not empty/)

  const again = await cli(home, dir, 'share', '--api', s.site, '--yes', '--no-media')
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
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')
  const shared = s.films.get('film1')?.versions[0]
  s.corrupt.add(shared?.files['shaderera.json'] as string)
  const work = temp('work')
  const r = await cli(home, work, 'fork', 'film1', '--api', s.site)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /did not match its sha256/)
  assert.ok(!existsSync(join(work, 'film1')))

  // A version that names a path outside the folder is refused too.
  assert.ok(shared)
  shared.files['../escape.txt'] = shared.files['shaderera.json'] as string
  s.corrupt.clear()
  const bad = await cli(home, work, 'fork', 'film1', '--api', s.site)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /may not: \.\.\/escape\.txt/)
})

test("share sends a film's proxies and bake frames in its player; a player that does not build sends nothing", {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  const s = await fakeSite()
  s.options.needsPlayer = true
  const home = temp('home')
  const { root } = await footageProject()
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /share: \d+ files, .*, and a player of \d+ files, .*, to /)
  const player = s.films.get('film1')?.versions[0]?.player ?? {}
  for (const f of [
    'runner.html',
    'files/assets/clip.mp4',
    'media/assets/clip.mp4.mp4',
    'media/assets/clip.mp4.json',
    'bakes/level.json',
    'bakes/level/level.0.bin',
  ])
    assert.ok(player[f], `${f} in the player`)

  writeFileSync(join(root, 'out', 'level', 'level.1.bin'), new Uint8Array([9]))
  const before = s.requests.length
  const failed = await cli(home, root, 'share', '--api', s.site, '--yes')
  assert.equal(failed.status, 2)
  assert.match(
    failed.stderr,
    /The player did not build: Bake level: level\.1\.bin changed since it was made\. Run shaderera bake level\. Nothing was sent\./,
  )
  assert.deepEqual(
    s.requests.slice(before).map((q) => q.path),
    ['/films/health'],
    'nothing was sent (the parents were read)',
  )
})

test('share renders a poster and a loop, uploads them, sends their shas, and prints the film page', {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--json')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const { result } = JSON.parse(r.stdout)
  const version = s.films.get('film1')?.versions[0]
  assert.ok(version)
  const poster = join(mediaDir(root), 'poster.webp')
  const loop = join(mediaDir(root), 'loop.mp4')
  assert.equal(version.poster, hashFile(poster))
  assert.equal(version.loop, hashFile(loop))
  assert.deepEqual(s.objects.get(version.poster), readFileSync(poster), 'the poster, uploaded')
  assert.deepEqual(s.objects.get(version.loop), readFileSync(loop), 'the loop, uploaded')
  assert.deepEqual(result.warnings, [])
  assert.equal(result.poster, statSync(poster).size)
  assert.equal(result.loop, statSync(loop).size)
  assert.equal(result.url, `${s.site}/film/film1`, "the response's page, not the runner")

  // The poster: a webp no wider than the film (64) nor 1280, under 500 KB.
  const image = spawnSync('ffprobe', [
    ...['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width'],
    ...['-of', 'csv=p=0', poster],
  ])
  assert.equal(image.stdout.toString().trim(), 'webp,64')
  assert.ok(result.poster <= POSTER.bytes)
  // The loop: the 1 s film, silent H.264 at 480 wide, under 4 MB.
  const p = probe(loop)
  assert.equal(p.video?.codec, 'h264')
  assert.equal(p.video?.width, LOOP.width)
  assert.equal(p.audio, undefined)
  assert.ok(Math.abs(p.duration - 1) < 0.05, `${p.duration} s`)
  assert.ok(result.loop <= LOOP.bytes)

  // The plain lines: the page, never the runner.
  const again = await cli(home, root, 'share', '--api', s.site, '--yes')
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /\n {2}with a poster of \d+ B and a loop of \d+ KB\n/)
  assert.ok(again.stdout.endsWith(`\n  ${s.site}/film/film1\n`), again.stdout)
  assert.doesNotMatch(again.stdout, /runner/)
})

test('a film whose render throws is refused before anything is sent; --dry-run fails too; --no-media still shares', {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  // The loop starts at 0; the poster is at 0.5 s, which renders.
  const source = join(root, 'src', 'composition.ts')
  writeFileSync(
    source,
    readFileSync(source, 'utf8').replace(
      'render: async (t) => {',
      "render: async (t) => {\n      if (t === 0) throw new Error('the render broke at 0')",
    ),
  )
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const before = s.requests.length
  const r = await cli(home, root, 'share', '--api', s.site, '--yes')
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(
    r.stderr,
    /The film did not render: the loop: .*the render broke at 0.* Nothing was sent\./,
  )
  assert.doesNotMatch(r.stderr, /no poster|no loop/)
  assert.deepEqual(
    s.requests.slice(before).map((q) => q.path),
    ['/films/health'],
    'nothing was sent (the parents were read)',
  )
  assert.equal(s.films.size, 0)
  assert.equal(s.objects.size, 0)

  const dry = await cli(home, root, 'share', '--api', s.site, '--dry-run')
  assert.equal(dry.status, 2, dry.stdout + dry.stderr)
  assert.match(dry.stderr, /The film did not render: the loop: .*the render broke at 0/)
  assert.doesNotMatch(dry.stdout, /Nothing was sent \(--dry-run\)\.$/m)

  // --no-media skips the poster and loop on purpose: no render, so the film goes through.
  const skipped = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  assert.ok(skipped.stdout.endsWith(`\n  ${s.site}/film/film1\n`), skipped.stdout)
  const version = s.films.get('film1')?.versions[0]
  assert.ok(version && !('poster' in version) && !('loop' in version), 'no poster or loop sent')
})

test('a film that throws as it opens is refused before anything is sent', {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  const s = await fakeSite()
  const home = temp('home')
  const root = project()
  const source = join(root, 'src', 'composition.ts')
  writeFileSync(
    source,
    readFileSync(source, 'utf8').replace(
      'const open: Open = ({ io }) => {',
      "const open: Open = ({ io }) => {\n  if (io) throw new Error('the film broke as it opened')",
    ),
  )
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const before = s.requests.length
  const r = await cli(home, root, 'share', '--api', s.site, '--yes')
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(
    r.stderr,
    /The film did not render: .*the film broke as it opened.* Nothing was sent\./,
  )
  assert.deepEqual(
    s.requests.slice(before).map((q) => q.path),
    ['/films/health'],
  )
  assert.equal(s.films.size, 0)
})

test("share --no-media renders and sends neither; without a page in the response the url is the site's /film/<film>", async () => {
  const s = await fakeSite()
  s.options.page = false
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media', '--json')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const { result } = JSON.parse(r.stdout)
  assert.equal(result.url, 'https://shaderera.com/film/film1')
  assert.equal(result.poster, null)
  assert.equal(result.loop, null)
  assert.deepEqual(result.warnings, [])
  const version = s.films.get('film1')?.versions[0]
  assert.ok(version)
  assert.ok(!('poster' in version) && !('loop' in version), 'no poster or loop sent')
  assert.ok(!existsSync(mediaDir(root)), 'nothing rendered')
  assert.equal(r.stderr, '')
})

test("share builds the player for the parents the API's health names; an older API's: for --site alone", async () => {
  const s = await fakeSite()
  const app = 'https://app.example'
  const page = 'https://site.example'
  // The app twice, the site, and entries that are no origin, which are left out.
  s.options.parents = [app, page, app, 'not an origin', 'https://site.example/film/x']
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const parentsMeta = () =>
    /name="shaderera-parents" content="([^"]*)"/.exec(
      readFileSync(join(playerDir(root), 'runner.html'), 'utf8'),
    )?.[1]
  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media', '--json')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).result.parents, [app, page])
  assert.equal(parentsMeta(), `${app} ${page}`)
  assert.ok(
    s.requests.some((q) => q.method === 'GET' && q.path === '/films/health' && !q.auth),
    'the health is asked, without the token',
  )
  const said = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')
  assert.match(said.stdout, new RegExp(`the player plays on ${app}, ${page}\n`))

  // An API without the field: the player is for --site alone, and the page falls back to it.
  s.options.parents = null
  s.options.page = false
  const old = await cli(
    home,
    root,
    ...['share', '--api', s.site, '--site', 'http://localhost:5193', '--yes', '--no-media'],
    '--json',
  )
  assert.equal(old.status, 0, old.stdout + old.stderr)
  const { result } = JSON.parse(old.stdout)
  assert.deepEqual(result.parents, ['http://localhost:5193'])
  assert.equal(result.url, `http://localhost:5193/film/${result.film}`)
  assert.equal(parentsMeta(), 'http://localhost:5193')
})

test('an API answer that is not JSON shows its status and first line, never the page', async () => {
  const html = createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end(
      `<!doctype html>\n<html><head><title>404</title></head>\n<body>${'x'.repeat(5000)}</body></html>`,
    )
  })
  await new Promise<void>((done) => html.listen(0, '127.0.0.1', done))
  after(() => html.close())
  const api = `http://127.0.0.1:${(html.address() as AddressInfo).port}`
  const home = temp('home')
  const r = await cli(home, home, 'fork', 'film1', '--api', api)
  assert.equal(r.status, 2)
  assert.equal(
    r.stderr.trim(),
    `shaderera: GET /films/film1 on ${api}: 404 (not the films API's answer) <!doctype html>`,
  )
  assert.doesNotMatch(r.stderr, /xxxx|<body>/)
})

test('an API that answers 426 says, in one line, that this CLI is too old and what to update to', async () => {
  const old = createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'This client is too old.', minimum: '9.0.0' }))
  })
  await new Promise<void>((done) => old.listen(0, '127.0.0.1', done))
  after(() => old.close())
  const api = `http://127.0.0.1:${(old.address() as AddressInfo).port}`
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  const home = temp('home')
  const r = await cli(home, home, 'fork', 'film1', '--api', api)
  assert.equal(r.status, 2)
  assert.equal(
    r.stderr.trim(),
    `shaderera: shaderera ${version} is too old for ${api}: update to 9.0.0 or later (npx shaderera@latest …)`,
  )
})

test("a share stops before uploading when it can't read the API's limits; a dry run warns and says limitsChecked: false", async () => {
  const s = await fakeSite()
  s.options.health = 'html'
  const home = temp('home')
  const root = project()
  await cli(home, root, 'login', '--token', s.TOKEN, '--api', s.site)
  const r = await cli(home, root, 'share', '--api', s.site, '--yes', '--no-media')
  assert.equal(r.status, 2)
  assert.match(
    r.stderr,
    new RegExp(
      `couldn't read the films API's limits at ${s.site}: it answered 200 with something other than JSON: <!doctype html>\\. Nothing was sent\\.`,
    ),
  )
  assert.deepEqual(
    s.requests.map((q) => q.path),
    ['/films/health'],
  )

  const dry = await cli(home, root, 'share', '--api', s.site, '--dry-run', '--no-media', '--json')
  assert.equal(dry.status, 0, dry.stdout + dry.stderr)
  assert.equal(JSON.parse(dry.stdout).result.limitsChecked, false)
  assert.match(dry.stderr, /! couldn't read the films API's limits at .*other than JSON/)

  // An API that is not there at all.
  const down = await cli(
    home,
    root,
    'share',
    '--api',
    'http://127.0.0.1:1',
    '--dry-run',
    '--no-media',
  )
  assert.equal(down.status, 0, down.stdout + down.stderr)
  assert.match(
    down.stderr,
    /couldn't read the films API's limits at http:\/\/127\.0\.0\.1:1: cannot be reached/,
  )

  s.options.health = 'json'
  const ok = await cli(home, root, 'share', '--api', s.site, '--dry-run', '--no-media', '--json')
  assert.equal(JSON.parse(ok.stdout).result.limitsChecked, true)
})

test('the flags before --api and --site say what to use instead; render keeps its --from and --to', async () => {
  const home = temp('home')
  const to = await cli(home, home, 'share', '--to', 'https://a.example')
  assert.equal(to.status, 2)
  assert.match(to.stderr, /shaderera share has no --to: use --api <origin>\./)
  const from = await cli(home, home, 'add', 'x', '--from=/tmp/plugins')
  assert.match(from.stderr, /shaderera add has no --from: use --site <origin\|folder>\./)
  const parent = await cli(home, home, 'studio', '--parent', 'https://a.example')
  assert.match(parent.stderr, /has no --parent: the player's parents come from the films API/)
  const render = await cli(home, home, 'render', '--from', '0', '--to', '1')
  assert.doesNotMatch(render.stderr, /has no --/)
})
