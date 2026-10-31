// Protocol v2 of the bridge (decision 0025, docs/studio.md): what /info, /events and the new
// routes give the page, on a project of the test's own.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { after, before, test as nodeTest, type TestFn } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { tempDir } from '../fixtures/temp.ts'
import { record } from '../project/activity.ts'
import { listing, replyTo, setState } from '../project/comments.ts'
import { prune } from '../project/prune.ts'
import {
  fileAt,
  head,
  log as revisionLog,
  save,
  scanProject,
  treeId,
} from '../project/revisions.ts'
import { toPng } from '../review/review.ts'
import { type Bridge, startBridge } from './bridge.ts'
import { call, events, nonce, page } from './fixtures/page.ts'
import { startRelay } from './fixtures/relay.ts'
import { makeId, seal, unseal } from './pairing.ts'
import { connectRelay } from './relay.ts'

const home = tempDir('home')
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_TELEMETRY

const test = (name: string, fn: TestFn) => nodeTest(name, { timeout: 60_000 }, fn)
const SITE = 'https://shaderera.example'
const jsonOf = (r: { body: Buffer }) => JSON.parse(r.body.toString('utf8'))

const root = tempDir('studio-v2')
cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), root, {
  recursive: true,
})
let bridge: Bridge
let relay: Awaited<ReturnType<typeof startRelay>>
before(async () => {
  relay = await startRelay()
  bridge = await startBridge({
    root,
    api: SITE,
    site: SITE,
    origins: [SITE],
    settleMs: 50,
    // Long enough that three runners asked one after the other on a loaded machine are all still
    // within it when the third is asked.
    runnerKeepMs: 5_000,
  })
})
after(async () => {
  await bridge.close()
  await relay.close()
})
const get = (path: string) =>
  call(bridge.port, { path, headers: { Origin: SITE, Authorization: `Bearer ${bridge.secret}` } })
const post = (path: string, body: unknown) =>
  call(bridge.port, {
    method: 'POST',
    path,
    headers: { Origin: SITE, Authorization: `Bearer ${bridge.secret}` },
    body,
  })

test('/info gives the tree, the head and whether an agent waits for comments', async () => {
  const saved = save(root, { by: 'person' }).id
  const info = jsonOf(await get('/info'))
  assert.equal(info.revision, treeId(scanProject(root)))
  assert.equal(info.head, saved)
  assert.equal(info.listening, false)
  // The films API is said only when it is not the default.
  assert.equal(info.api, SITE)
  // A waiter touches its file every second: a file younger than 5 s is an agent waiting.
  const waits = join(root, '.shaderera', 'comments.wait')
  mkdirSync(waits, { recursive: true })
  writeFileSync(join(waits, '12345'), '')
  assert.equal(jsonOf(await get('/info')).listening, true)
  const old = new Date(Date.now() - 6000)
  utimesSync(join(waits, '12345'), old, old)
  assert.equal(jsonOf(await get('/info')).listening, false)
})

test('agent: the bridge says when an agent starts and stops waiting', async () => {
  const sse = events(bridge)
  await sse.opened
  const waits = join(root, '.shaderera', 'comments.wait')
  mkdirSync(waits, { recursive: true })
  writeFileSync(join(waits, '777'), '')
  assert.deepEqual(await sse.next((e) => e.type === 'agent' && e.listening === true), {
    type: 'agent',
    listening: true,
  })
  const old = new Date(Date.now() - 6000)
  utimesSync(join(waits, '777'), old, old)
  await sse.next((e) => e.type === 'agent' && e.listening === false)
  sse.close()
})

test('changed names the files, and the edit is in the activity', async () => {
  const sse = events(bridge)
  await sse.opened
  writeFileSync(join(root, 'src', 'extra.ts'), 'export const extra = 1\n')
  const changed = await sse.next(
    (e) => e.type === 'changed' && JSON.stringify(e.files).includes('src/extra.ts'),
  )
  assert.deepEqual(changed.files, { added: ['src/extra.ts'], removed: [], changed: [] })
  assert.equal(changed.revision, treeId(scanProject(root)))
  const edit = await sse.next((e) => e.type === 'activity')
  assert.deepEqual((edit.entry as { kind: string; files: unknown; by: string }).kind, 'edit')
  assert.deepEqual((edit.entry as { files: unknown }).files, changed.files)
  assert.equal((edit.entry as { by: string }).by, 'studio')
  // The tree after the edit, for the page's "Copy diff": in the file, as in the event.
  assert.equal((edit.entry as { revision: string }).revision, changed.revision)
  const line = readFileSync(join(root, '.shaderera', 'activity.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((e) => e.id === (edit.entry as { id: string }).id)
  assert.equal(line.revision, changed.revision)
  sse.close()
})

test('/activity: what the CLI and the agent did, newest last, and an entry image', async () => {
  const sse = events(bridge)
  await sse.opened
  const png = await toPng(new Uint8Array(4 * 4 * 4).fill(255), 4, 4)
  const entry = record(root, { by: 'agent', kind: 'note', text: 'trying a warmer grey' }, png)
  assert.ok(entry)
  // Another process's line: the bridge's watcher tails the file.
  const seen = await sse.next(
    (e) => e.type === 'activity' && (e.entry as { id: string }).id === entry.id,
  )
  assert.equal((seen.entry as { image: unknown }).image, true)
  const list = jsonOf(await get('/activity?limit=200'))
  assert.ok(Array.isArray(list))
  const last = list.at(-1)
  assert.equal(last.id, entry.id)
  assert.equal(last.text, 'trying a warmer grey')
  assert.equal(last.image, true)
  assert.equal(jsonOf(await get('/activity?limit=1')).length, 1)
  const image = await get(`/activity/${entry.id}/image`)
  assert.equal(image.status, 200)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.ok(image.body.equals(png))
  assert.equal((await get('/activity/nope/image')).status, 404)
  assert.equal((await get('/activity?limit=x')).status, 400)
  sse.close()
})

test('/versions gives the head, the log and the saved revisions', async () => {
  const saved = save(root, { by: 'person', label: 'v2 test' })
  const v = jsonOf(await get('/versions'))
  assert.equal(v.head, head(root))
  assert.equal(v.log.at(-1).id, saved.id)
  const rev = v.revisions.find((r: { id: string }) => r.id === saved.id)
  assert.deepEqual(Object.keys(rev).sort(), ['by', 'created', 'id', 'label', 'parent'])
  assert.equal(rev.label, 'v2 test')
})

test('/file serves a file the film plays, and refuses the rest', async () => {
  mkdirSync(join(root, 'audio'), { recursive: true })
  const wav = Buffer.from('RIFF....WAVEfmt ')
  writeFileSync(join(root, 'audio', 'score.wav'), wav)
  writeFileSync(join(root, '.env'), 'TOKEN=secret\n')
  const ok = await get('/file?path=audio/score.wav')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'audio/wav')
  assert.ok(ok.body.equals(wav))
  for (const path of [
    '../outside.wav',
    'audio/../../x',
    '.env',
    'versions/log.jsonl',
    'out/a.mp4',
    'C:/x',
  ])
    assert.equal((await get(`/file?path=${encodeURIComponent(path)}`)).status, 400, path)
  assert.equal((await get('/file?path=audio/none.wav')).status, 404)
  assert.equal((await get('/file')).status, 400)
})

test('a render is in the activity, not the log', async () => {
  const sse = events(bridge)
  await sse.opened
  const { job } = jsonOf(await post('/render', { format: 'png', t: 0 }))
  const entry = await sse.next(
    (e) => e.type === 'activity' && (e.entry as { kind: string }).kind === 'render',
  )
  assert.deepEqual(
    {
      kind: (entry.entry as { kind: string }).kind,
      ok: (entry.entry as { ok: boolean }).ok,
      format: (entry.entry as { format: string }).format,
      job: (entry.entry as { job: string }).job,
    },
    { kind: 'render', ok: true, format: 'png', job },
  )
  assert.ok(!sse.got.some((e) => e.type === 'log' && /^render /.test(String(e.text))))
  sse.close()
})

test('/render {revision} renders that revision, not the tree', async () => {
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  manifest.params.properties.grey.default = 40
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify(manifest))
  const old = save(root, { by: 'person' }).id
  manifest.params.properties.grey.default = 200
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify(manifest))
  const sse = events(bridge)
  await sse.opened
  assert.equal((await post('/render', { format: 'png', revision: 'f'.repeat(16) })).status, 404)
  assert.equal((await post('/render', { format: 'png', revision: 'nope' })).status, 400)
  const { job } = jsonOf(await post('/render', { format: 'png', t: 0, revision: old }))
  const end = await sse.next(
    (e) => e.type === 'job' && e.id === job && (e.state === 'done' || e.state === 'failed'),
  )
  assert.equal(end.state, 'done', JSON.stringify(end))
  const png = decode((await get(`/render/${job}/file`)).body)
  // The first pixel's red: the old grey, 40.
  assert.equal(png.data[0], 40)
  sse.close()
})

const ffprobe = spawnSync('ffprobe', ['-version']).status === 0

test('/render {revision, from, to, draft}: those seconds of that revision, at the draft size', async (t) => {
  if (!ffprobe) return t.skip('no ffprobe')
  // A draft opens the source smaller: this one draws at the host's size, not 16×16 of its own.
  const file = join(root, 'src', 'composition.ts')
  const own = readFileSync(file, 'utf8')
  writeFileSync(
    file,
    own
      .replace('({ io, params })', '({ io, manifest, params })')
      .replace('io.canvas(16, 16)', 'io.canvas(manifest.width, manifest.height)')
      .replace('ctx.fillRect(0, 0, 16, 16)', 'ctx.fillRect(0, 0, canvas.width, canvas.height)'),
  )
  const old = save(root, { by: 'person' }).id
  writeFileSync(file, own)
  const sse = events(bridge)
  await sse.opened
  const { job } = jsonOf(
    await post('/render', { format: 'mp4', revision: old, from: 0.5, to: 1, draft: 8 }),
  )
  const end = await sse.next(
    (e) => e.type === 'job' && e.id === job && (e.state === 'done' || e.state === 'failed'),
  )
  sse.close()
  assert.equal(end.state, 'done', JSON.stringify(end))
  const name = readdirSync(join(root, 'out', 'studio')).find((n) => n.endsWith(`-${job}.mp4`))
  assert.equal(name, `${basename(root)}-${old}-0.5-1.0-draft-${job}.mp4`)
  const probe = spawnSync('ffprobe', [
    ...['-v', 'error', '-count_frames', '-select_streams', 'v:0'],
    ...['-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0'],
    join(root, 'out', 'studio', name as string),
  ])
  // 16×16 at 10 fps: 8×8, the five frames from 0.5 s up to 1 s
  assert.equal(probe.stdout.toString().trim(), '8,8,5')
})

test('/runner?revision= frames a runner on that revision, the tree changed since', async () => {
  const file = join(root, 'src', 'composition.ts')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n// the old one\n`)
  const old = save(root, { by: 'person' }).id
  writeFileSync(file, readFileSync(file, 'utf8').replace('// the old one', '// the new one'))
  const at = async (revision?: string) => {
    const r = await call(bridge.port, {
      path: `/runner?s=${bridge.secret}${revision ? `&revision=${revision}` : ''}`,
    })
    assert.equal(r.status, 302, r.body.toString())
    const page = new URL(String(r.headers.location))
    const base = page.pathname.slice(0, page.pathname.indexOf('__shaderera/'))
    return (await fetch(new URL(`${base}src/composition.ts`, page))).text()
  }
  assert.match(await at(old), /the old one/)
  assert.match(await at(), /the new one/)
  assert.equal(
    (await call(bridge.port, { path: `/runner?s=${bridge.secret}&revision=${'f'.repeat(16)}` }))
      .status,
    404,
  )
})

test('comments: the person comments, replies and resolves through the bridge', async () => {
  const sse = events(bridge)
  await sse.opened
  const shown = jsonOf(await get('/info')).revision
  assert.equal((await post('/comments', { revision: shown, t: 99, text: 'late' })).status, 400)
  assert.equal((await post('/comments', { revision: shown, t: 0.2 })).status, 400)
  const made = await post('/comments', {
    revision: shown,
    t: 0.2,
    text: 'warmer here',
    point: [4, 4],
  })
  assert.equal(made.status, 200, made.body.toString())
  const thread = jsonOf(made)
  assert.equal(thread.by, 'person')
  assert.equal(thread.state, 'open')
  // The tree the person saw is saved as a revision.
  assert.equal(thread.revision, head(root))
  const event = await sse.next(
    (e) => e.type === 'comment' && (e.comment as { id: string }).id === thread.id,
  )
  assert.equal((event.comment as { text: string }).text, 'warmer here')
  const list = jsonOf(await get('/comments'))
  assert.ok(Array.isArray(list))
  assert.ok(list.some((c: { id: string }) => c.id === thread.id))
  assert.equal((await get('/comments?state=bogus')).status, 400)

  // The agent fixes it (another process writes the file): the folded thread comes as an event.
  writeFileSync(join(root, 'src', 'fix.ts'), 'export const fix = 1\n')
  const asked = Date.now()
  await replyTo(root, thread.id, 'warmer now', { by: 'agent', fixed: true })
  const fixed = await sse.next(
    (e) => e.type === 'comment' && (e.comment as { state: string }).state === 'fixed',
  )
  assert.ok(Date.now() - asked < 2000)
  assert.equal((fixed.comment as { replies: { fixed?: boolean }[] }).replies[0]?.fixed, true)

  // The person's reply reopens it; the person resolves it.
  const reply = jsonOf(await post(`/comments/${thread.id}/reply`, { text: 'not quite' }))
  assert.equal(reply.state, 'open')
  assert.equal(reply.replies.at(-1).by, 'person')
  const resolved = jsonOf(await post(`/comments/${thread.id}/state`, { state: 'resolved' }))
  assert.equal(resolved.state, 'resolved')
  assert.equal((await post(`/comments/${thread.id}/state`, { state: 'fixed' })).status, 400)
  assert.equal((await post('/comments/nope00/reply', { text: 'x' })).status, 404)
  assert.equal(jsonOf(await get('/comments?state=resolved')).length, 1)
  sse.close()
})

/** A request through the relay, as the page sends it when it cannot reach 127.0.0.1. */
const throughRelay = async () => {
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
  let n = 0
  const rpc = async (request: unknown) => {
    const rid = String(++n)
    p.send({ type: 'rpc', id: rid, ...(await seal(key, request)) })
    const m = (await p.next('rpc-result')) as unknown as { id: string; iv: string; box: string }
    assert.equal(m.id, rid)
    return unseal<{ status: number; body?: unknown }>(key, m)
  }
  return {
    rpc,
    close: async () => {
      await cli.close()
      p.ws.close()
    },
  }
}

test('/file refuses another case, a short name and a link in capitals, directly and through the relay', async () => {
  writeFileSync(join(root, '.env'), 'TOKEN=secret\n')
  writeFileSync(join(root, 'src', 'id.pem'), 'key')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[remote] url = https://user:token@host/x')
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{"x":{"command":"evil"}}}')
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', 'x.mp4'), 'x')
  const outside = tempDir('outside')
  writeFileSync(join(outside, 'x.txt'), 'not the project')
  symlinkSync(outside, join(root, 'Linked'), 'junction')
  const paths = [
    '.ENV',
    '.Env',
    'ENV~1',
    'src/ID.PEM',
    '.GIT/config',
    '.MCP.json',
    'OUT/x.mp4',
    'Linked/x.txt',
    'LINKED/x.txt',
  ]
  const relayed = await throughRelay()
  try {
    for (const path of paths) {
      const direct = await get(`/file?path=${encodeURIComponent(path)}`)
      assert.ok([400, 404].includes(direct.status), `${path}: ${direct.status}`)
      const far = await relayed.rpc({
        method: 'GET',
        path: `/file?path=${encodeURIComponent(path)}`,
      })
      assert.ok([400, 404].includes(far.status), `${path} through the relay: ${far.status}`)
    }
  } finally {
    await relayed.close()
  }
})

test('/runner through the relay is refused before any runner or frozen copy is made', async () => {
  const file = join(root, 'src', 'composition.ts')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n// relayed\n`)
  const id = save(root, { by: 'person' }).id
  const relayed = await throughRelay()
  try {
    const r = await relayed.rpc({ method: 'GET', path: `/runner?revision=${id}` })
    assert.equal(r.status, 400)
    assert.equal(existsSync(join(root, '.shaderera', 'revisions', id)), false)
  } finally {
    await relayed.close()
  }
})

test('a third revision runner closes the least recently used, once its frame had time to load', async () => {
  const file = join(root, 'src', 'composition.ts')
  const ids: string[] = []
  for (const n of [1, 2, 3]) {
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// three ${n}\n`)
    ids.push(save(root, { by: 'person' }).id)
  }
  const runnerOf = async (id: string) => {
    const r = await call(bridge.port, { path: `/runner?s=${bridge.secret}&revision=${id}` })
    assert.equal(r.status, 302)
    return new URL(String(r.headers.location))
  }
  // Its own page answers 200 at its secret path; once it has closed, another server may take the
  // port (a parallel test, another studio) and answer 404 there.
  const alive = (at: URL) =>
    fetch(at).then(
      (r) => r.ok,
      () => false,
    )
  const pages = []
  for (const id of ids) pages.push(await runnerOf(id))
  // All three were just sent: none is closed under the page loading it.
  assert.deepEqual(await Promise.all(pages.map(alive)), [true, true, true])
  // Past the keep time and the next poll, the least recently used goes.
  for (let i = 0; i < 300 && (await alive(pages[0] as URL)); i++)
    await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(await Promise.all(pages.map(alive)), [false, true, true])
})

test('comments: the input is checked, and the revision is the one the page shows', async () => {
  const shown = jsonOf(await get('/info')).revision
  const comment = (body: object) =>
    post('/comments', { revision: shown, t: 0.1, text: 'x', ...body })
  // In the fixture's 16×16 frame.
  for (const body of [
    { revision: undefined },
    { revision: 'nope' },
    { revision: 'f'.repeat(16) },
    { point: [16, 0] },
    { point: [-1, 2] },
    { box: [0, 0, 0, 4] },
    { box: [10, 10, 8, 8] },
    { object: 'x'.repeat(201) },
    { object: 5 },
    { shot: { id: 's' } },
    { params: [] },
    { params: { big: 'x'.repeat(17_000) } },
  ]) {
    const r = await comment(body)
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
  }
  // A saved revision the page held: the comment points at it, and nothing new is saved.
  const held = save(root, { by: 'person' }).id
  writeFileSync(join(root, 'src', 'later.ts'), 'export const later = 1\n')
  const before = jsonOf(await get('/versions')).revisions.length
  const made = jsonOf(await post('/comments', { revision: held, t: 0.1, text: 'on the held one' }))
  assert.equal(made.revision, held)
  assert.equal(jsonOf(await get('/versions')).revisions.length, before)
})

test('the activity goes on through a rotation, and the poll finds what no watch said', async () => {
  const sse = events(bridge)
  await sse.opened
  // Past 1 MB: the log rotates, and the entries after it still come.
  for (let i = 0; i < 300; i++)
    record(root, { by: 'agent', kind: 'note', text: `${i} ${'x'.repeat(3990)}` })
  const after = record(root, { by: 'agent', kind: 'note', text: 'after the rotation' })
  assert.ok(after)
  await sse.next((e) => e.type === 'activity' && (e.entry as { id: string }).id === after.id)
  sse.close()

  // A bridge that leaves the files to its poll.
  const other = tempDir('studio-poll')
  cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), other, {
    recursive: true,
  })
  const polled = await startBridge({
    root: other,
    api: SITE,
    site: SITE,
    origins: [SITE],
    tailOnWatch: false,
  })
  try {
    const seen = events(polled)
    await seen.opened
    const entry = record(other, { by: 'cli', kind: 'note', text: 'polled' })
    assert.ok(entry)
    await seen.next((e) => e.type === 'activity' && (e.entry as { id: string }).id === entry.id)
    seen.close()
  } finally {
    await polled.close()
  }
})

test('a comment on a framed tree the agent edited since points at the files the person saw', async () => {
  const file = join(root, 'src', 'composition.ts')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n// what the person saw\n`)
  // The page frames the working tree: the bridge stores it, unlisted.
  const shown = jsonOf(await get('/info')).revision
  assert.equal((await call(bridge.port, { path: `/runner?s=${bridge.secret}` })).status, 302)
  assert.ok(!revisionLog(root).some((e) => e.id === shown))
  const listed = jsonOf(await get('/versions')).revisions.find(
    (r: { id: string }) => r.id === shown,
  )
  assert.equal(listed.unlisted, true)
  // The agent edits while the person writes.
  writeFileSync(file, readFileSync(file, 'utf8').replace('what the person saw', 'the agent edit'))
  const made = await post('/comments', { revision: shown, t: 0.1, text: 'this one' })
  assert.equal(made.status, 200, made.body.toString())
  assert.equal(jsonOf(made).revision, shown)
  assert.match(String(fileAt(root, shown, 'src/composition.ts')), /what the person saw/)

  // Another framed tree nobody comments on: prune drops it, and keeps the commented one.
  assert.equal((await call(bridge.port, { path: `/runner?s=${bridge.secret}` })).status, 302)
  const unnamed = jsonOf(await get('/info')).revision
  const later = Date.now() + 3600_000
  const pruned = prune(root, { keep: 100, now: () => later })
  assert.ok(pruned.removed.includes(unnamed), JSON.stringify(pruned.removed))
  assert.ok(!pruned.removed.includes(shown))
})

test('the person deletes a comment: listings drop it, the event and show still say so', async () => {
  const sse = events(bridge)
  await sse.opened
  const shown = jsonOf(await get('/info')).revision
  const made = jsonOf(await post('/comments', { revision: shown, t: 0.1, text: 'never mind' }))
  const gone = await post(`/comments/${made.id}/state`, { state: 'deleted' })
  assert.equal(gone.status, 200, gone.body.toString())
  assert.equal(jsonOf(gone).state, 'deleted')
  await sse.next(
    (e) =>
      e.type === 'comment' &&
      (e.comment as { id: string; state: string }).id === made.id &&
      (e.comment as { state: string }).state === 'deleted',
  )
  assert.ok(!jsonOf(await get('/comments')).some((c: { id: string }) => c.id === made.id))
  assert.equal(listing(root, { id: made.id }).comments[0]?.state, 'deleted')
  // Final: no reply, no reopen; and only the person deletes.
  assert.equal((await post(`/comments/${made.id}/reply`, { text: 'back?' })).status, 400)
  assert.equal((await post(`/comments/${made.id}/state`, { state: 'open' })).status, 400)
  const other = jsonOf(await post('/comments', { revision: shown, t: 0.2, text: 'keep' }))
  await assert.rejects(setState(root, other.id, 'deleted', 'agent'), /Only the person deletes/)
  sse.close()
})

test('/info leaves out the default films API', async () => {
  const other = tempDir('studio-api')
  cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), other, {
    recursive: true,
  })
  const b = await startBridge({
    root: other,
    api: 'https://api.shaderera.com',
    site: SITE,
    origins: [SITE],
  })
  try {
    const info = jsonOf(
      await call(b.port, {
        path: '/info',
        headers: { Origin: SITE, Authorization: `Bearer ${b.secret}` },
      }),
    )
    assert.equal('api' in info, false)
  } finally {
    await b.close()
  }
})
