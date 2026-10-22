import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { run } from './fork.ts'

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex')
const VERSION = 'a'.repeat(64)
const SITE = 'https://site.example'

/**
 * A fake of the films API's read routes, in the shapes of shaderera.com's API.md: `GET
 * /films/:film` (a Film with its versions), `GET /versions/:v/revision` and `GET /obj/:sha`. Each
 * object answers after `delay` ms; it counts the downloads in flight at once.
 */
const fakeApi = async (files: Record<string, string>, licence: string, delay = 0) => {
  const objects = new Map(Object.values(files).map((text) => [sha256(text), text]))
  const revision = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, sha256(t)]))
  const flight = { now: 0, most: 0, gets: 0 }
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '').replace(/^\/api\/v1/, '')
    if (path === '/films/film1')
      return json(res, 200, {
        id: 'film1',
        title: 'test film',
        owner: 'ana',
        latestVersion: VERSION,
        forkedFrom: null,
        poster: null,
        loop: null,
        posterUrl: null,
        loopUrl: null,
        licence,
        createdAt: 1,
        updatedAt: 1,
        meta: null,
        playable: false,
        player: 'https://player.example',
        versions: [
          { id: VERSION, licence, size: 1, shaderera: '0.1.5', createdAt: 1, playable: false },
        ],
      })
    if (path === `/versions/${VERSION}/revision`)
      return json(res, 200, { version: VERSION, files: revision })
    const obj = /^\/obj\/([0-9a-f]{64})$/.exec(path)
    const o = obj && objects.get(obj[1] as string)
    if (o === undefined || o === null) return json(res, 404, { error: 'Not found.' })
    flight.gets++
    flight.most = Math.max(flight.most, ++flight.now)
    await new Promise((r) => setTimeout(r, delay))
    flight.now--
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(o)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  after(() => server.close())
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, flight }
}

/** Runs fork with its console caught. */
const fork = async (api: string, dir: string, ...flags: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const { log, warn } = console
  console.log = (...a: unknown[]) => void out.push(a.join(' '))
  console.warn = (...a: unknown[]) => void err.push(a.join(' '))
  try {
    const status = await run(['film1', dir, '--api', api, '--site', SITE, ...flags])
    return { status, stdout: out.join('\n'), stderr: err.join('\n') }
  } finally {
    Object.assign(console, { log, warn })
  }
}

const project = (extra: Record<string, string> = {}) => ({
  'shaderera.json': '{"entry":"src/composition.ts"}',
  'package.json': JSON.stringify({ name: 'test-film', license: 'MIT' }),
  ...extra,
})

test('fork downloads a few files at a time, and every one arrives whole', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`src/f${i}.txt`, `file ${i}`]),
  )
  const { api, flight } = await fakeApi(project(many), 'MIT', 20)
  const dir = join(tempDir('fork'), 'out')
  const r = await fork(api, dir)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(flight.gets, 26)
  assert.ok(flight.most > 1 && flight.most <= 8, `${flight.most} at once`)
  for (let i = 0; i < 24; i++)
    assert.equal(readFileSync(join(dir, 'src', `f${i}.txt`), 'utf8'), `file ${i}`)
})

test('fork records where it came from in package.json and the README, and says nothing of an open licence', async () => {
  const { api } = await fakeApi(project({ 'README.md': '# test film\n\nWhat it is.\n' }), 'MIT')
  const dir = join(tempDir('fork'), 'out')
  const r = await fork(api, dir, '--json')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  const from = {
    film: 'film1',
    title: 'test film',
    owner: 'ana',
    version: VERSION,
    licence: 'MIT',
    page: `${SITE}/film/film1`,
  }
  const result = JSON.parse(r.stdout)
  assert.deepEqual(result.forkedFrom, from)
  assert.deepEqual(result.warnings, [])
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(pkg, { name: 'test-film', license: 'MIT', forkedFrom: from })
  assert.equal(
    readFileSync(join(dir, 'README.md'), 'utf8'),
    `# test film\n\nWhat it is.\n\nForked from "test film" by ana (${SITE}/film/film1), version ${VERSION}, licence MIT.\n`,
  )
})

for (const licence of ['All rights reserved', 'UNLICENSED'])
  test(`fork warns when the licence is ${licence}, and makes a README when there is none`, async () => {
    const { api } = await fakeApi(project(), licence)
    const dir = join(tempDir('fork'), 'out')
    const r = await fork(api, dir)
    assert.equal(r.status, 0, r.stderr)
    assert.match(
      r.stderr,
      new RegExp(`^! licence ${licence}: ana keeps every right to "test film"\\. .*ask them`),
    )
    assert.match(r.stdout, new RegExp(`licence ${licence}`))
    assert.ok(existsSync(join(dir, 'README.md')))
    assert.match(
      readFileSync(join(dir, 'README.md'), 'utf8'),
      new RegExp(`^# test film\\n\\nForked from "test film" by ana .*licence ${licence}\\.\\n$`),
    )
  })
