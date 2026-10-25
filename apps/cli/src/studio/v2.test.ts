// Protocol v2 of the bridge (decision 0025, docs/studio.md): what /info, /events and the new
// routes give the page, on a project of the test's own.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test as nodeTest, type TestFn } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { tempDir } from '../fixtures/temp.ts'
import { record } from '../project/activity.ts'
import { replyTo } from '../project/comments.ts'
import { head, save, scanProject, treeId } from '../project/revisions.ts'
import { toPng } from '../review/review.ts'
import { type Bridge, startBridge } from './bridge.ts'
import { call, events } from './fixtures/page.ts'

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
before(async () => {
  bridge = await startBridge({ root, api: SITE, site: SITE, origins: [SITE], settleMs: 50 })
})
after(async () => {
  await bridge.close()
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
  assert.equal((await post('/comments', { t: 99, text: 'late' })).status, 400)
  assert.equal((await post('/comments', { t: 0.2 })).status, 400)
  const made = await post('/comments', { t: 0.2, text: 'warmer here', point: [4, 4] })
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
