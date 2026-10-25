import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { hashInputs } from './bakes.ts'
import { diffRevisions } from './diff.ts'
import { createJob, verifyJob } from './jobs.ts'
import { prune } from './prune.ts'
import {
  hashFile,
  log,
  materialize,
  prunedIds,
  readRevision,
  releaseFrozen,
  restore,
  save,
} from './revisions.ts'

const fixture = fileURLToPath(new URL('../cli/fixtures/mcp/', import.meta.url))

/** The MCP fixture (a red box) in a fresh folder. */
const project = () => {
  const root = join(tempDir('prune'), 'film')
  cpSync(fixture, root, { recursive: true })
  return root
}
const objects = (root: string) => readdirSync(join(root, 'versions', 'objects')).sort()
const hashOf = (text: string) => {
  const dir = tempDir('hash')
  writeFileSync(join(dir, 'f'), text)
  return hashFile(join(dir, 'f'))
}
/** Every stored file made old, past the time a save in flight may still be using it. */
const age = (root: string) => {
  const old = new Date(Date.now() - 24 * 3600_000)
  for (const o of objects(root)) utimesSync(join(root, 'versions', 'objects', o), old, old)
}
/** Saves the project with `asset.bin` holding `text`. */
const saveWith = (root: string, text: string, label?: string) => {
  writeFileSync(join(root, 'asset.bin'), text)
  return save(root, { by: 'cli', ...(label ? { label } : {}) }).id
}

test('prune --keep 0 keeps the job revision and the labelled one, and drops B with the objects only B held', async () => {
  const root = project()
  const a = saveWith(root, 'A only')
  const job = await createJob(root, { by: 'cli', revision: a, name: 'approved' })
  const b = saveWith(root, 'B only')
  const c = saveWith(root, 'C only', 'client round 1')
  age(root)
  const before = objects(root)

  // A dry run says what would go and removes nothing.
  const dry = prune(root, { keep: 0, dryRun: true })
  assert.deepEqual(dry.removed, [b])
  assert.deepEqual(dry.objects, [hashOf('B only')])
  assert.ok(dry.bytes > 0)
  assert.deepEqual(objects(root), before)
  assert.ok(readRevision(root, b))

  const done = prune(root, { keep: 0 })
  assert.deepEqual(done.removed, [b])
  assert.deepEqual(
    done.kept.map((k) => k.id),
    [a, c].sort(),
  )
  assert.deepEqual(
    objects(root),
    before.filter((o) => o !== hashOf('B only')),
  )
  // The log keeps every line; B is marked pruned, and naming it says so.
  assert.ok(log(root).some((e) => e.id === b))
  assert.deepEqual([...prunedIds(root)], [b])
  assert.throws(() => diffRevisions(root, b), new RegExp(`Revision ${b} was pruned`))
  assert.throws(() => restore(root, b), /was pruned/)
  // What is kept still works: the job's frozen copy builds from its objects, and A restores.
  await verifyJob(root, job)
  restore(root, a)
  assert.equal(readFileSync(join(root, 'asset.bin'), 'utf8'), 'A only')
  // Pruning again finds nothing more.
  assert.deepEqual(prune(root, { keep: 0 }).removed, [])
})

test('prune keeps the last n saves, what comments and bake stamps name, and frozen copies', () => {
  const root = project()
  const ids = ['one', 'two', 'three', 'four', 'five', 'six'].map((t) => saveWith(root, t))
  const [one, two, three, four, five, six] = ids as [string, string, string, string, string, string]
  // A comment names two (its revision) and three (fixedIn); a torn last line is skipped.
  writeFileSync(
    join(root, 'versions', 'comments.jsonl'),
    `${JSON.stringify({ op: 'comment', id: 'c1', revision: two, t: 1, text: 'darker' })}\n${JSON.stringify({ op: 'state', id: 'c1', state: 'fixed', fixedIn: three })}\n{"op":"comm`,
  )
  // A bake was made from asset.bin as four has it.
  mkdirSync(join(root, 'versions', 'bakes'))
  const inputs = hashInputs(root, ['asset.bin'], readRevision(root, four).files)
  writeFileSync(
    join(root, 'versions', 'bakes', 'glow.json'),
    JSON.stringify({ shaderera: 'bake/1', name: 'glow', bake: { inputs: ['asset.bin'] }, inputs }),
  )
  // Another live process (this one's parent) is rendering from one's frozen copy.
  mkdirSync(join(root, '.shaderera', 'revisions', one), { recursive: true })
  mkdirSync(join(root, '.shaderera', 'revisions', `${one}.using`))
  writeFileSync(join(root, '.shaderera', 'revisions', `${one}.using`, String(process.ppid)), '')
  age(root)
  const r = prune(root, { keep: 1 })
  assert.deepEqual(r.removed, [five])
  const why = Object.fromEntries(r.kept.map((k) => [k.id, k.why.join(', ')]))
  assert.deepEqual(why, {
    [one]: 'a frozen copy in use',
    [two]: 'a comment',
    [three]: 'a comment',
    [four]: 'bake glow',
    [six]: 'the head, the last save',
  })
})

test('prune never removes an object a save may be using now', () => {
  const root = project()
  const a = saveWith(root, 'old')
  const b = saveWith(root, 'recent')
  saveWith(root, 'now')
  // Nothing is aged: every object was used within the last minutes, by a save that may still run.
  const r = prune(root, { keep: 0 })
  assert.deepEqual(r.removed, [a, b].sort())
  assert.deepEqual(r.objects, [])
  assert.ok(existsSync(join(root, 'versions', 'objects', hashOf('recent'))))
  // A save that finds an object already stored marks it used, as it does one it writes.
  age(root)
  const object = join(root, 'versions', 'objects', hashOf('old'))
  const aged = statSync(object).mtimeMs
  saveWith(root, 'old')
  assert.ok(statSync(object).mtimeMs > aged)
})

test('prune removes nothing when a job, a stamp or a revision cannot be read', () => {
  const root = project()
  saveWith(root, 'one')
  saveWith(root, 'two')
  mkdirSync(join(root, 'versions', 'jobs'))
  writeFileSync(join(root, 'versions', 'jobs', 'broken.json'), '{"revision": ')
  assert.throws(() => prune(root, { keep: 0 }), /versions\/jobs\/broken.json.*nothing was removed/)
  assert.equal(readdirSync(join(root, 'versions', 'revisions')).length, 2)
})

test('prune removes the frozen copies nobody uses, and keeps one a live process uses', () => {
  const root = project()
  const a = saveWith(root, 'a')
  const b = saveWith(root, 'b')
  const copies = join(root, '.shaderera', 'revisions')
  materialize(root, a)
  releaseFrozen(root, a)
  materialize(root, b)
  writeFileSync(join(copies, `${b}.using`, String(process.ppid)), '')
  releaseFrozen(root, b)
  const old = new Date(Date.now() - 24 * 3600_000)
  for (const id of [a, b]) utimesSync(join(copies, id), old, old)
  age(root)
  const dry = prune(root, { keep: 10, dryRun: true })
  assert.deepEqual(dry.copies, [a])
  assert.ok(existsSync(join(copies, a)))
  const done = prune(root, { keep: 10 })
  assert.deepEqual(done.copies, [a])
  assert.ok(dry.bytes > 0 && done.bytes === dry.bytes)
  assert.deepEqual(readdirSync(copies).sort(), [b, `${b}.using`].sort())
  // The revision stays (a save), and a render makes its copy again.
  assert.ok(existsSync(join(materialize(root, a), 'asset.bin')))
  releaseFrozen(root, a)
})
