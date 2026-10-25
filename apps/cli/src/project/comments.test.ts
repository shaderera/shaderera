import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import {
  addComment,
  commentsFile,
  fold,
  listing,
  MAX_TEXT,
  newId,
  type Op,
  parseOps,
  readThreads,
  replyTo,
  setState,
  waitForComments,
} from './comments.ts'
import { prune } from './prune.ts'

const comment = (id: string, at: string, extra: Partial<Op> = {}): Op =>
  ({
    op: 'comment',
    at,
    by: 'person',
    id,
    revision: '0123456789abcdef',
    t: 1,
    frame: 30,
    text: `comment ${id}`,
    ...extra,
  }) as Op

/** A project with one source file, in a temp folder. */
const project = () => {
  const root = tempDir('comments')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/c.ts',
      fps: 30,
      duration: 4,
      width: 1920,
      height: 1080,
      params: { type: 'object', properties: { accent: { type: 'string', default: '#fff' } } },
      variants: { '9:16': { width: 1080, height: 1920 } },
    }),
  )
  writeFileSync(join(root, 'src', 'c.ts'), 'export default () => ({ render: async () => ({}) })\n')
  return root
}

test('the fold: open → fixed (a reply with fixed) → resolved (only by the person)', () => {
  const ops: Op[] = [
    comment('aaaaaa', '2026-10-25T10:00:00Z'),
    { op: 'reply', at: '2026-10-25T10:01:00Z', by: 'agent', id: 'aaaaaa', text: 'on it' },
    {
      op: 'reply',
      at: '2026-10-25T10:02:00Z',
      by: 'agent',
      id: 'aaaaaa',
      text: 'moved it',
      fixed: true,
      revision: 'fedcba9876543210',
    },
    // An agent's resolve is not one.
    { op: 'state', at: '2026-10-25T10:03:00Z', by: 'agent', id: 'aaaaaa', state: 'resolved' },
  ]
  const [t] = fold(ops)
  assert.equal(t?.state, 'fixed')
  assert.equal(t?.fixedIn, 'fedcba9876543210')
  assert.deepEqual(
    t?.replies.map((r) => [r.by, r.text]),
    [
      ['agent', 'on it'],
      ['agent', 'moved it'],
    ],
  )
  const done = fold([
    ...ops,
    { op: 'state', at: '2026-10-25T10:04:00Z', by: 'person', id: 'aaaaaa', state: 'resolved' },
  ])
  assert.equal(done[0]?.state, 'resolved')
  assert.equal(done[0]?.updated, '2026-10-25T10:04:00Z')
})

test("the fold: the person's reply reopens a fixed comment; the agent's does not; reopen", () => {
  const fixed: Op[] = [
    comment('aaaaaa', 'a'),
    { op: 'reply', at: 'b', by: 'agent', id: 'aaaaaa', text: 'done', fixed: true, revision: 'r' },
  ]
  assert.equal(
    fold([...fixed, { op: 'reply', at: 'c', by: 'agent', id: 'aaaaaa', text: 'also' }])[0]?.state,
    'fixed',
  )
  assert.equal(
    fold([...fixed, { op: 'reply', at: 'c', by: 'person', id: 'aaaaaa', text: 'not yet' }])[0]
      ?.state,
    'open',
  )
  const resolved: Op[] = [
    ...fixed,
    { op: 'state', at: 'c', by: 'person', id: 'aaaaaa', state: 'resolved' },
  ]
  assert.equal(
    fold([...resolved, { op: 'state', at: 'd', by: 'agent', id: 'aaaaaa', state: 'open' }])[0]
      ?.state,
    'open',
  )
})

test('the fold keeps the first comment of an id, skips replies to none, and keeps order', () => {
  const threads = fold([
    comment('bbbbbb', 'a'),
    comment('aaaaaa', 'b'),
    comment('bbbbbb', 'c', { text: 'again' }),
    { op: 'reply', at: 'd', by: 'agent', id: 'zzzzzz', text: 'lost' },
  ])
  assert.deepEqual(
    threads.map((t) => [t.id, t.text]),
    [
      ['bbbbbb', 'comment bbbbbb'],
      ['aaaaaa', 'comment aaaaaa'],
    ],
  )
})

test('a torn last line, and any line that is not an operation, is skipped', () => {
  const text = `${JSON.stringify(comment('aaaaaa', 'a'))}\n{"op":"nope"}\n${JSON.stringify(comment('bbbbbb', 'b')).slice(0, 40)}`
  assert.deepEqual(
    parseOps(text).map((o) => o.id),
    ['aaaaaa'],
  )
})

test('ids: 6 characters of the studio alphabet, never one already taken', () => {
  let n = 0
  // A random source that gives the taken id first.
  const bytes = (k: number) => Buffer.from(Array.from({ length: k }, () => (n++ < 6 ? 0 : 1)))
  const id = newId(new Set(['aaaaaa']), bytes)
  assert.equal(id, 'bbbbbb')
  assert.match(newId(new Set()), /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/)
})

test('add: t, frame, range, variant size, point, params that differ; text capped', async () => {
  const root = project()
  const c = await addComment(
    root,
    {
      t: 1.5,
      to: 2,
      variant: '9:16',
      point: [540, 300],
      params: { accent: '#fff', other: 1 },
      text: 'the logo',
    },
    'person',
  )
  assert.match(c.id, /^[a-z2-9]{6}$/)
  assert.equal(c.frame, 45)
  assert.equal(c.toFrame, 60)
  assert.deepEqual(c.size, [1080, 1920])
  assert.deepEqual(c.params, { other: 1 })
  assert.match(c.revision, /^[0-9a-f]{16}$/)
  assert.equal(c.state, 'open')
  await assert.rejects(addComment(root, { t: 9, text: 'x' }, 'person'), /outside the film/)
  await assert.rejects(
    addComment(root, { t: 1, point: [1, 2], box: [0, 0, 1, 1], text: 'x' }, 'person'),
    /a point or a box/,
  )
  await assert.rejects(
    addComment(root, { t: 1, text: 'x'.repeat(MAX_TEXT + 1) }, 'person'),
    /4000 characters/,
  )
  assert.equal(readThreads(root).length, 1)
})

test('reply --fixed: refused on the tree commented on; then saves a labelled revision prune keeps', async () => {
  const root = project()
  const c = await addComment(root, { t: 1, text: 'too dark' }, 'person')
  assert.throws(
    () => replyTo(root, c.id, 'brighter', { by: 'agent', fixed: true }),
    /nothing changed since/,
  )
  writeFileSync(join(root, 'src', 'c.ts'), '// brighter\n')
  const fixed = replyTo(root, c.id, 'made the background brighter', { by: 'agent', fixed: true })
  assert.equal(fixed.state, 'fixed')
  assert.match(fixed.fixedIn ?? '', /^[0-9a-f]{16}$/)
  const log = readFileSync(join(root, 'versions', 'log.jsonl'), 'utf8')
  assert.match(log, new RegExp(`"label":"fix ${c.id}: made the background brighter"`))
  // Both revisions the comment names stay through a prune that keeps nothing else.
  writeFileSync(join(root, 'src', 'c.ts'), '// later\n')
  await addComment(root, { t: 2, text: 'and here' }, 'person')
  const kept = prune(root, { keep: 0, dryRun: true }).kept
  for (const id of [c.revision, fixed.fixedIn])
    assert.ok(
      kept.some((k) => k.id === id && k.why.includes('a comment')),
      `${id} kept: ${JSON.stringify(kept)}`,
    )
})

test('only the person resolves; stale when the tree is not the one commented on', async () => {
  const root = project()
  const c = await addComment(root, { t: 1, text: 'x' }, 'person')
  assert.throws(() => setState(root, c.id, 'resolved', 'agent'), /Only the person resolves/)
  assert.equal(listing(root, { state: 'all' }).comments[0]?.stale, false)
  writeFileSync(join(root, 'src', 'c.ts'), '// edited\n')
  const now = listing(root, { state: 'all' })
  assert.equal(now.comments[0]?.stale, true)
  assert.notEqual(now.revision, c.revision)
  assert.equal(setState(root, c.id, 'resolved', 'person').state, 'resolved')
  assert.deepEqual(listing(root).comments, [])
  assert.throws(() => replyTo(root, 'nonono', 'x', { by: 'agent' }), /No comment nonono/)
})

test('two processes appending at once lose no operation', async () => {
  const root = project()
  const N = 400
  const script = `
import { appendOp } from ${JSON.stringify(new URL('./comments.ts', import.meta.url).href)}
import { existsSync, writeFileSync } from 'node:fs'
const [root, tag, n] = process.argv.slice(2)
// Ready, then both start together when the test says go.
writeFileSync(root + '/ready-' + tag, '')
while (!existsSync(root + '/go')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
for (let i = 0; i < Number(n); i++)
  appendOp(root, { op: 'reply', at: new Date().toISOString(), by: 'agent', id: 'aaaaaa', text: tag + i + ' ' + 'x'.repeat(i % 3 === 0 ? 3000 : 10) })
`
  const file = join(root, 'append.mjs')
  writeFileSync(file, script)
  const runOne = (tag: string) =>
    new Promise<number | null>((resolve) =>
      spawn(process.execPath, [file, root, tag, String(N)], { stdio: 'inherit' }).on(
        'exit',
        resolve,
      ),
    )
  const ran = Promise.all([runOne('a'), runOne('b')])
  while (!['a', 'b'].every((t) => existsSync(join(root, `ready-${t}`))))
    await new Promise((r) => setTimeout(r, 20))
  writeFileSync(join(root, 'go'), '')
  assert.deepEqual(await ran, [0, 0])
  const ops = parseOps(readFileSync(commentsFile(root), 'utf8'))
  assert.equal(ops.length, 2 * N)
  for (const tag of ['a', 'b'])
    assert.equal(ops.filter((o) => o.op === 'reply' && o.text.startsWith(tag)).length, N)
  // They ran at once: the lines of the two interleave.
  const order = ops.map((o) => (o.op === 'reply' ? o.text[0] : '')).join('')
  assert.ok((order.match(/ab|ba/g) ?? []).length > 10, order)
})

test('a line written by hand without a newline at the end is still read', () => {
  const root = project()
  mkdirSync(join(root, 'versions'), { recursive: true })
  appendFileSync(commentsFile(root), JSON.stringify(comment('aaaaaa', 'a')))
  assert.equal(readThreads(root).length, 1)
})

test('waiting wakes on a reply that reopens a fixed comment, not on the fix itself', async () => {
  const root = project()
  const c = await addComment(root, { t: 1, text: 'x' }, 'person')
  writeFileSync(join(root, 'src', 'c.ts'), '// fixed\n')
  replyTo(root, c.id, 'done', { by: 'agent', fixed: true })
  const woke = waitForComments(root, { pollMs: 100 })
  replyTo(root, c.id, 'thanks, but no', { by: 'agent' })
  const late = await Promise.race([woke, new Promise((r) => setTimeout(() => r('still'), 400))])
  assert.equal(late, 'still')
  replyTo(root, c.id, 'still too dark', { by: 'person' })
  const { comments } = await woke
  assert.deepEqual(
    comments.map((x) => [x.id, x.state]),
    [[c.id, 'open']],
  )
})
