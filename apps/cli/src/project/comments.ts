import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { type Json, type Manifest, parseFps } from '@shaderera/core'
import { withVariant } from '@shaderera/core/host'
import { findProject } from '../node/project.ts'
import { ID_ALPHABET } from '../studio/pairing.ts'
import { type By, head, save, scanProject, treeId } from './revisions.ts'

/**
 * Comments on the film (decision 0025): what the person leaves at a moment of it, and the replies.
 *
 *   versions/comments.jsonl   one operation a line, only ever appended: comment, reply, state
 *
 * Read, the lines fold into threads (`fold`, pure). A line that is not an operation (a torn last
 * line) is skipped. Every writer (the CLI, MCP, the studio's bridge) appends through `appendOp`,
 * which holds `versions/comments.lock` for the moment of the append: a comment's id is checked
 * against the ids already there and its line written in one step, and a line longer than an
 * atomic write (a 4000-character comment in Thai is about 12 KB) never interleaves with another.
 */

export const MAX_TEXT = 4000
export type Point = [number, number]
export type Box = [number, number, number, number]
export type CommentState = 'open' | 'fixed' | 'resolved'

export type CommentOp = {
  op: 'comment'
  at: string
  by: By
  id: string
  /** The tree the person saw: saved as a revision when the comment is made. */
  revision: string
  variant?: string
  t: number
  frame: number
  to?: number
  toFrame?: number
  /** In that variant's frame pixels, with its `size`. */
  point?: Point
  box?: Box
  size?: [number, number]
  /** What the page's runner picked at the point. */
  object?: string
  shot?: { id: string; offset: number }
  /** Only the params that differ from the defaults. */
  params?: { [name: string]: Json }
  text: string
}
export type ReplyOp = {
  op: 'reply'
  at: string
  by: By
  id: string
  text: string
  /** The reply that says it is fixed, in `revision`. */
  fixed?: true
  revision?: string
}
export type StateOp = { op: 'state'; at: string; by: By; id: string; state: 'open' | 'resolved' }
export type Op = CommentOp | ReplyOp | StateOp

export type Reply = Omit<ReplyOp, 'op' | 'id'>
export type Thread = Omit<CommentOp, 'op'> & {
  state: CommentState
  /** The revision of the last fix. */
  fixedIn?: string
  replies: Reply[]
  /** When the last operation on it was written. */
  updated: string
}

const BY = new Set(['person', 'agent', 'cli', 'studio'])
const isOp = (o: unknown): o is Op => {
  if (!o || typeof o !== 'object') return false
  const x = o as { [k: string]: unknown }
  if (typeof x.at !== 'string' || typeof x.id !== 'string' || !BY.has(x.by as string)) return false
  if (x.op === 'comment')
    return typeof x.revision === 'string' && typeof x.t === 'number' && typeof x.text === 'string'
  if (x.op === 'reply') return typeof x.text === 'string'
  if (x.op === 'state') return x.state === 'open' || x.state === 'resolved'
  return false
}

/** The operations in a comments.jsonl's text; any line that is not one (a torn last line) is skipped. */
export const parseOps = (text: string): Op[] =>
  text.split('\n').flatMap((line) => {
    try {
      const o = JSON.parse(line)
      return isOp(o) ? [o] : []
    } catch {
      return []
    }
  })

/**
 * The threads the operations make, in the order their comments were made:
 * - a reply with `fixed` makes it `fixed`, in its `revision`;
 * - the person's reply to a `fixed` comment reopens it;
 * - `resolved` counts only from the person; `open` (reopen) from anyone.
 * The first comment of an id is the one; a reply or state for no comment is skipped.
 */
export const fold = (ops: readonly Op[]): Thread[] => {
  const threads = new Map<string, Thread>()
  for (const o of ops) {
    if (o.op === 'comment') {
      if (threads.has(o.id)) continue
      const { op: _, ...c } = o
      threads.set(o.id, { ...c, state: 'open', replies: [], updated: o.at })
      continue
    }
    const t = threads.get(o.id)
    if (!t) continue
    if (o.op === 'reply') {
      const { op: _, id: __, ...reply } = o
      t.replies.push(reply)
      if (o.fixed) {
        t.state = 'fixed'
        if (o.revision) t.fixedIn = o.revision
      } else if (o.by === 'person' && t.state === 'fixed') t.state = 'open'
    } else if (o.state === 'resolved') {
      if (o.by !== 'person') continue
      t.state = 'resolved'
    } else t.state = 'open'
    t.updated = o.at
  }
  return [...threads.values()]
}

export const commentsFile = (root: string) => join(root, 'versions', 'comments.jsonl')

/** The project's comments as threads. */
export const readThreads = (root: string): Thread[] => {
  const file = commentsFile(root)
  return existsSync(file) ? fold(parseOps(readFileSync(file, 'utf8'))) : []
}

/** 6 characters of the studio's id alphabet, uniformly (rejection sampling), not in `taken`. */
export const newId = (
  taken: ReadonlySet<string>,
  bytes: (n: number) => Uint8Array = randomBytes,
) => {
  for (;;) {
    const out: string[] = []
    while (out.length < 6)
      for (const b of bytes(12))
        if (b < 248 && out.length < 6) out.push(ID_ALPHABET[b % 31] as string)
    const id = out.join('')
    if (!taken.has(id)) return id
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
/** An append takes milliseconds: a lock older than this was left by a writer that died holding it. */
const STALE_MS = 10_000

/** Holds `versions/comments.lock` (a folder: mkdir is atomic everywhere) while `run` runs. */
const locked = <T>(root: string, run: () => T): T => {
  const lock = join(root, 'versions', 'comments.lock')
  mkdirSync(join(root, 'versions'), { recursive: true })
  const until = Date.now() + 2 * STALE_MS
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmdirSync(lock)
      } catch {}
      if (Date.now() > until) throw new Error(`${lock} is held: is another shaderera stuck?`)
      sleep(5)
    }
  }
  try {
    return run()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Whether the file ends in a newline (or is empty): a torn last line must not swallow the next. */
const endsWithNewline = (file: string) => {
  const fd = openSync(file, 'r')
  try {
    const { size } = fstatSync(fd)
    if (size === 0) return true
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

/**
 * Appends one operation, under the lock. A comment without an id gets a new one, checked against
 * every id in the file. Returns the operation as written.
 */
export const appendOp = <O extends Op>(root: string, op: O): O =>
  locked(root, () => {
    const file = commentsFile(root)
    const exists = existsSync(file)
    let written = op
    if (op.op === 'comment' && !op.id) {
      const ids = new Set(exists ? parseOps(readFileSync(file, 'utf8')).map((o) => o.id) : [])
      written = { ...op, id: newId(ids) }
    }
    const lead = exists && !endsWithNewline(file) ? '\n' : ''
    appendFileSync(file, `${lead}${JSON.stringify(written)}\n`)
    return written
  })

const checkText = (text: string) => {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('A comment needs its text.')
  if ([...text].length > MAX_TEXT)
    throw new Error(
      `A comment is at most ${MAX_TEXT} characters (this one is ${[...text].length}).`,
    )
}

const threadOf = (root: string, id: string) => {
  const t = readThreads(root).find((x) => x.id === id)
  if (!t) throw new Error(`No comment ${id}: \`shaderera comments --state all\` lists them.`)
  return t
}

export type NewComment = {
  t: number
  to?: number
  variant?: string
  point?: Point
  box?: Box
  object?: string
  shot?: { id: string; offset: number }
  params?: { [name: string]: Json }
  text: string
}

const numbers = (v: unknown, n: number, what: string) => {
  if (
    !Array.isArray(v) ||
    v.length !== n ||
    v.some((x) => typeof x !== 'number' || !Number.isFinite(x))
  )
    throw new Error(`${what} is ${n} numbers in frame pixels.`)
  return v as number[]
}

/** The params that differ from the manifest's defaults. */
const changedParams = (manifest: Manifest, params: { [name: string]: Json }) => {
  const props = (
    manifest.params as { properties?: { [k: string]: { default?: Json } } } | undefined
  )?.properties
  const out = Object.fromEntries(
    Object.entries(params).filter(
      ([k, v]) => JSON.stringify(props?.[k]?.default) !== JSON.stringify(v),
    ),
  )
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Makes a comment on the tree as it is now: saves it as a revision (decision 0025, point 5), then
 * appends the comment. `t` (and `to`) must be inside the film; `point` or `box` are in the
 * variant's frame pixels.
 */
export const addComment = async (root: string, c: NewComment, by: By): Promise<Thread> => {
  checkText(c.text)
  if (c.point && c.box) throw new Error('A comment has a point or a box, not both.')
  const { manifest: base } = await findProject(root)
  const { manifest } = withVariant(base, c.variant)
  const fps = (parseFps(manifest.fps) as { fps: number }).fps
  const inside = (t: number) => Number.isFinite(t) && t >= 0 && t < manifest.duration
  if (!inside(c.t)) throw new Error(`t ${c.t} is outside the film (0 to ${manifest.duration} s).`)
  if (c.to !== undefined && !(inside(c.to) && c.to > c.t))
    throw new Error(
      `to ${c.to} is not after t ${c.t} inside the film (0 to ${manifest.duration} s).`,
    )
  const point = c.point ? (numbers(c.point, 2, 'point') as Point) : undefined
  const box = c.box ? (numbers(c.box, 4, 'box') as Box) : undefined
  const revision = save(root, { by }).id
  const params = c.params ? changedParams(manifest, c.params) : undefined
  const op = appendOp(root, {
    op: 'comment',
    at: new Date().toISOString(),
    by,
    id: '',
    revision,
    ...(c.variant !== undefined ? { variant: c.variant } : {}),
    t: c.t,
    frame: Math.round(c.t * fps),
    ...(c.to !== undefined ? { to: c.to, toFrame: Math.round(c.to * fps) } : {}),
    ...(point ? { point } : {}),
    ...(box ? { box } : {}),
    ...(point || box ? { size: [manifest.width, manifest.height] as [number, number] } : {}),
    ...(c.object !== undefined ? { object: c.object } : {}),
    ...(c.shot !== undefined ? { shot: c.shot } : {}),
    ...(params ? { params } : {}),
    text: c.text,
  })
  return threadOf(root, op.id)
}

/** The id of the working tree as it is now (what `save` would give it), without saving. */
export const currentTree = (root: string) => treeId(scanProject(root))

/**
 * Replies to a comment. With `fixed`, the tree is saved as a revision labelled
 * `fix <id>: <text>` and the comment is fixed in it; refused when the tree is still the one the
 * comment was made on (nothing was changed to fix it).
 */
export const replyTo = (
  root: string,
  id: string,
  text: string,
  o: { by: By; fixed?: boolean },
): Thread => {
  checkText(text)
  const t = threadOf(root, id)
  let revision: string | undefined
  if (o.fixed) {
    if (t.state === 'resolved')
      throw new Error(`Comment ${id} is resolved: the person reopens it before it is fixed again.`)
    if (currentTree(root) === t.revision)
      throw new Error(
        `Refusing to mark ${id} fixed: nothing changed since the revision it was made on (${t.revision}).`,
      )
    revision = save(root, { by: o.by, label: `fix ${id}: ${[...text].slice(0, 60).join('')}` }).id
  }
  appendOp(root, {
    op: 'reply',
    at: new Date().toISOString(),
    by: o.by,
    id,
    text,
    ...(revision ? { fixed: true as const, revision } : {}),
  })
  return threadOf(root, id)
}

/** Resolves (only the person) or reopens a comment. */
export const setState = (root: string, id: string, state: 'open' | 'resolved', by: By): Thread => {
  if (state === 'resolved' && by !== 'person')
    throw new Error(
      `Only the person resolves a comment: they resolve ${id} in the studio, or with \`shaderera comments resolve ${id}\` in their own terminal.`,
    )
  threadOf(root, id)
  appendOp(root, { op: 'state', at: new Date().toISOString(), by, id, state })
  return threadOf(root, id)
}

export type Listing = {
  /** The working tree's id now. */
  revision: string
  head: string | null
  comments: (Thread & { stale: boolean })[]
}

/**
 * What `shaderera comments --json` and MCP `comments` give: the threads in `state` (open by
 * default; `all`), or the one with `id`, each `stale` when the tree now is not the one it was
 * made on.
 */
export const listing = (
  root: string,
  o: { state?: CommentState | 'all'; id?: string } = {},
): Listing => {
  const state = o.state ?? 'open'
  if (!['open', 'fixed', 'resolved', 'all'].includes(state))
    throw new Error(`state is open, fixed, resolved or all, not ${state}.`)
  const revision = currentTree(root)
  const threads =
    o.id !== undefined
      ? [threadOf(root, o.id)]
      : readThreads(root).filter((t) => state === 'all' || t.state === state)
  return {
    revision,
    head: head(root),
    comments: threads.map((t) => ({ ...t, stale: t.revision !== revision })),
  }
}

export const waitFile = (root: string) => join(root, '.shaderera', 'comments.wait')

/**
 * Resolves with the comments that became open after it started (a new one, or one reopened by a
 * reply or a state), as `listing` gives them. While it waits, `.shaderera/comments.wait` holds
 * this process's pid, so the bridge can say the agent is listening; it is removed when it ends.
 * fs.watch wakes it at once; a poll every `pollMs` catches what a watch misses.
 */
export const waitForComments = (
  root: string,
  o: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<Listing> => {
  const was = new Map(readThreads(root).map((t) => [t.id, t.state]))
  const marker = waitFile(root)
  mkdirSync(join(root, '.shaderera'), { recursive: true })
  mkdirSync(join(root, 'versions'), { recursive: true })
  writeFileSync(marker, `${process.pid}\n`)
  return new Promise((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | undefined
    const end = () => {
      clearInterval(poll)
      watcher?.close()
      rmSync(marker, { force: true })
    }
    const look = () => {
      try {
        const now = readThreads(root)
        const woke = now.filter((t) => t.state === 'open' && was.get(t.id) !== 'open')
        for (const t of now) was.set(t.id, t.state)
        if (woke.length === 0) return
        end()
        const all = listing(root, { state: 'all' })
        const ids = new Set(woke.map((t) => t.id))
        resolve({ ...all, comments: all.comments.filter((t) => ids.has(t.id)) })
      } catch (e) {
        end()
        reject(e)
      }
    }
    const poll = setInterval(look, o.pollMs ?? 1000)
    try {
      watcher = watch(join(root, 'versions'), (_, file) => {
        if (!file || file === 'comments.jsonl') look()
      })
      watcher.on('error', () => {})
    } catch {}
    o.signal?.addEventListener('abort', () => {
      end()
      reject(new Error('stopped waiting'))
    })
  })
}
