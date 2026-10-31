import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { type Json, type Manifest, parseFps } from '@shaderera/core'
import { checkManifest, withVariant } from '@shaderera/core/host'
import { findProject } from '../node/project.ts'
import { ID_ALPHABET } from '../studio/pairing.ts'
import { type By, endsWithNewline, fileAt, head, save, scanProject, treeId } from './revisions.ts'

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
/** `deleted`: the person took the comment back; listings leave it out, `show` still says so. */
export type CommentState = 'open' | 'fixed' | 'resolved' | 'deleted'

/**
 * The frame that shows at t: floor(t·fps), with 1e-6 for t that fall just short of a frame in
 * floating point. The product's one rule, the studio page's readout's: 2.4608 s at 60 fps is 147.
 */
export const frameShownAt = (t: number, fps: number) => Math.floor(t * fps + 1e-6)

/** A time for a person to read: to the millisecond (the JSON keeps t whole). */
export const seconds = (t: number) => `${Number(t.toFixed(3))} s`

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
export type StateOp = {
  op: 'state'
  at: string
  by: By
  id: string
  state: 'open' | 'resolved' | 'deleted'
}
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
  if (x.op === 'state') return x.state === 'open' || x.state === 'resolved' || x.state === 'deleted'
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
 * - `resolved` counts only from the person; `open` (reopen) from anyone;
 * - `deleted` counts only from the person, and is final: later operations on it change nothing.
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
    if (!t || t.state === 'deleted') continue
    if (o.op === 'reply') {
      const { op: _, id: __, ...reply } = o
      t.replies.push(reply)
      if (o.fixed) {
        // A resolved comment is the person's to reopen: a fix on it, by anyone, changes nothing.
        if (t.state !== 'resolved') {
          t.state = 'fixed'
          if (o.revision) t.fixedIn = o.revision
        }
      } else if (o.by === 'person' && t.state === 'fixed') t.state = 'open'
    } else if (o.state === 'resolved' || o.state === 'deleted') {
      if (o.by !== 'person') continue
      t.state = o.state
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

/** An append takes milliseconds: a lock older than this was left by a writer that died holding it. */
const STALE_MS = 10_000

/** The token in a lock folder, or null when it has none (yet) or is gone. */
const ownerOf = (lock: string) => {
  try {
    return readFileSync(join(lock, 'owner'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Holds `versions/comments.lock` while `run` runs. The lock is a folder (mkdir is atomic
 * everywhere) holding `owner`, this taker's token. A lock untouched for `STALE_MS` was left by a
 * writer that died: it is taken over by renaming it to a name of this taker's own (only one
 * rename of a folder succeeds), then making a new one; if what was renamed turns out to be
 * another taker's fresh lock, it is put back. The lock is removed at the end only while it still
 * holds this taker's token. Waits without blocking the event loop.
 */
export const withCommentsLock = async <T>(
  root: string,
  run: () => T | Promise<T>,
  o: { staleMs?: number } = {},
): Promise<T> => {
  const staleMs = o.staleMs ?? STALE_MS
  const lock = join(root, 'versions', 'comments.lock')
  mkdirSync(join(root, 'versions'), { recursive: true })
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const until = Date.now() + 3 * staleMs
  let refused: unknown
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), token)
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // On Windows a lock its holder is removing is pending delete, and mkdir fails with EPERM
      // until it has gone: held a moment longer, not an error (#422).
      if (process.platform === 'win32' && code === 'EPERM') refused = e
      else if (code !== 'EEXIST') throw e
    }
    try {
      const seen = ownerOf(lock)
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        const aside = `${lock}.${token}`
        renameSync(lock, aside)
        if (ownerOf(aside) === seen) rmSync(aside, { recursive: true, force: true })
        // Another taker's lock, made after the stale one was judged: give it back.
        else renameSync(aside, lock)
        continue
      }
    } catch {}
    if (Date.now() > until)
      throw new Error(`${lock} is held: is another shaderera stuck?`, { cause: refused })
    await delay(5)
  }
  try {
    return await run()
  } finally {
    if (ownerOf(lock) === token) rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * Appends one operation, under the lock. A comment without an id gets a new one, checked against
 * every id in the file. Returns the operation as written.
 */
export const appendOp = <O extends Op>(root: string, op: O): Promise<O> =>
  withCommentsLock(root, () => {
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
  /**
   * The tree the person was watching (the studio page sends the one it shows): the working tree's
   * id now, which is saved, or a saved revision's. Without it, the tree now is saved.
   */
  revision?: string
}

/** The longest `object` and shot id, and the most a comment's params hold (as JSON). */
const MAX_NAME = 200
const MAX_PARAMS = 16 * 1024

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
  if (
    c.revision !== undefined &&
    (typeof c.revision !== 'string' || !/^[0-9a-f]{16}$/.test(c.revision))
  )
    throw new Error('revision is a revision id, 16 hex digits.')
  // A saved revision the person was watching is checked, and its own film placed against; the
  // tree as it is now is saved below.
  const saved = c.revision !== undefined && c.revision !== currentTree(root)
  const base = saved
    ? checkManifest(
        JSON.parse((fileAt(root, c.revision as string, 'shaderera.json') ?? '{}').toString('utf8')),
      )
    : (await findProject(root)).manifest
  const { manifest } = withVariant(base, c.variant)
  const fps = (parseFps(manifest.fps) as { fps: number }).fps
  const inside = (t: number) => Number.isFinite(t) && t >= 0 && t < manifest.duration
  if (!inside(c.t)) throw new Error(`t ${c.t} is outside the film (0 to ${manifest.duration} s).`)
  if (c.to !== undefined && !(inside(c.to) && c.to > c.t))
    throw new Error(
      `to ${c.to} is not after t ${c.t} inside the film (0 to ${manifest.duration} s).`,
    )
  const { width, height } = manifest
  const point = c.point ? (numbers(c.point, 2, 'point') as Point) : undefined
  if (point && !(point[0] >= 0 && point[0] < width && point[1] >= 0 && point[1] < height))
    throw new Error(`point is outside the frame (${width}×${height}).`)
  const box = c.box ? (numbers(c.box, 4, 'box') as Box) : undefined
  const [bx, bt, bw, bh] = box ?? [0, 0, 1, 1]
  if (box && !(bw > 0 && bh > 0 && bx >= 0 && bt >= 0 && bx + bw <= width && bt + bh <= height))
    throw new Error(`box is [x, y, width, height] inside the frame (${width}×${height}).`)
  if (c.object !== undefined && (typeof c.object !== 'string' || c.object.length > MAX_NAME))
    throw new Error(`object is an id of at most ${MAX_NAME} characters.`)
  if (
    c.shot !== undefined &&
    (typeof c.shot !== 'object' ||
      c.shot === null ||
      typeof c.shot.id !== 'string' ||
      c.shot.id.length > MAX_NAME ||
      typeof c.shot.offset !== 'number' ||
      !Number.isFinite(c.shot.offset))
  )
    throw new Error('shot is {id, offset}: a shot id and seconds into it.')
  if (
    c.params !== undefined &&
    (typeof c.params !== 'object' ||
      c.params === null ||
      Array.isArray(c.params) ||
      JSON.stringify(c.params).length > MAX_PARAMS)
  )
    throw new Error(`params is an object, at most ${MAX_PARAMS / 1024} KB as JSON.`)
  const revision = saved ? (c.revision as string) : save(root, { by }).id
  const params = c.params ? changedParams(manifest, c.params) : undefined
  const op = await appendOp(root, {
    op: 'comment',
    at: new Date().toISOString(),
    by,
    id: '',
    revision,
    ...(c.variant !== undefined ? { variant: c.variant } : {}),
    t: c.t,
    frame: frameShownAt(c.t, fps),
    ...(c.to !== undefined ? { to: c.to, toFrame: frameShownAt(c.to, fps) } : {}),
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
 * `fix <id>: <text>` and the comment is fixed in it; refused when the tree is still the one of
 * the comment's last fix, or the one it was made on when it has none (nothing was changed to fix it).
 */
export const replyTo = async (
  root: string,
  id: string,
  text: string,
  o: { by: By; fixed?: boolean },
): Promise<Thread> => {
  checkText(text)
  const t = threadOf(root, id)
  if (t.state === 'deleted') throw new Error(`Comment ${id} was deleted.`)
  let revision: string | undefined
  if (o.fixed) {
    if (t.state === 'resolved')
      throw new Error(`Comment ${id} is resolved: the person reopens it before it is fixed again.`)
    const last = t.fixedIn ?? t.revision
    if (currentTree(root) === last)
      throw new Error(
        `Refusing to mark ${id} fixed: nothing changed since ${t.fixedIn ? 'its last fix' : 'the revision it was made on'} (${last}).`,
      )
    revision = save(root, { by: o.by, label: `fix ${id}: ${[...text].slice(0, 60).join('')}` }).id
  }
  await appendOp(root, {
    op: 'reply',
    at: new Date().toISOString(),
    by: o.by,
    id,
    text,
    ...(revision ? { fixed: true as const, revision } : {}),
  })
  return threadOf(root, id)
}

/** Resolves or deletes (the person only: the studio writes it), or reopens a comment. */
export const setState = async (
  root: string,
  id: string,
  state: 'open' | 'resolved' | 'deleted',
  by: By,
): Promise<Thread> => {
  if (state === 'resolved' && by !== 'person')
    throw new Error('Resolve it in the studio: only the person resolves (ADR 0025).')
  if (state === 'deleted' && by !== 'person')
    throw new Error('Only the person deletes a comment, in the studio.')
  if (threadOf(root, id).state === 'deleted') throw new Error(`Comment ${id} was deleted.`)
  await appendOp(root, { op: 'state', at: new Date().toISOString(), by, id, state })
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
 * made on. A deleted comment is in no listing; asked for by `id`, it says it was deleted.
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
      : readThreads(root).filter(
          (t) => t.state !== 'deleted' && (state === 'all' || t.state === state),
        )
  return {
    revision,
    head: head(root),
    comments: threads.map((t) => ({ ...t, stale: t.revision !== revision })),
  }
}

/** The folder of waiters' files: one `<pid>` file each, `{pid, started}`, touched every poll. */
export const waitDir = (root: string) => join(root, '.shaderera', 'comments.wait')
/** A waiter's file untouched for longer than this is a waiter that died (or a reused pid's). */
export const LISTENING_MS = 5000

/**
 * Whether an agent waits on comments now: some waiter's file was touched in the last
 * `LISTENING_MS` (`staleMs`, for tests). Files older than that are removed. For the bridge's
 * `listening`.
 */
export const listening = (root: string, now = Date.now(), staleMs = LISTENING_MS): boolean => {
  let any = false
  let names: string[] = []
  try {
    names = readdirSync(waitDir(root))
  } catch {
    return false
  }
  for (const name of names) {
    const file = join(waitDir(root), name)
    try {
      if (now - statSync(file).mtimeMs <= staleMs) any = true
      else rmSync(file, { force: true })
    } catch {}
  }
  return any
}

/**
 * The comments the person opened since `before` operations: a new comment by the person, or the
 * person's reply or reopen that makes one open again. The agent's own comments and replies never
 * wake it (decision 0025, point 7).
 */
export const openedByPerson = (ops: readonly Op[], before: number): string[] => {
  const woke = new Set<string>()
  for (let i = before; i < ops.length; i++) {
    const o = ops[i] as Op
    if (o.by !== 'person') continue
    const was = fold(ops.slice(0, i)).find((t) => t.id === o.id)?.state
    const now = fold(ops.slice(0, i + 1)).find((t) => t.id === o.id)?.state
    if (now === 'open' && was !== 'open') woke.add(o.id)
  }
  return [...woke]
}

/**
 * Resolves with the comments the person opened after it started (`openedByPerson`), as
 * `listing` gives them. While it waits it keeps `.shaderera/comments.wait/<pid>` and touches it
 * on every poll, so the bridge can say the agent is listening; the file goes when it ends, and a
 * killed waiter's goes stale in `LISTENING_MS`. fs.watch wakes it at once; the poll (every
 * `pollMs`, at most 1 s) catches what a watch misses.
 */
export const waitForComments = (
  root: string,
  o: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<Listing> => {
  const file = commentsFile(root)
  const opsNow = () => (existsSync(file) ? parseOps(readFileSync(file, 'utf8')) : [])
  const start = opsNow().length
  const mine = join(waitDir(root), String(process.pid))
  mkdirSync(waitDir(root), { recursive: true })
  mkdirSync(join(root, 'versions'), { recursive: true })
  writeFileSync(mine, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
  return new Promise((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | undefined
    const end = () => {
      clearInterval(poll)
      watcher?.close()
      rmSync(mine, { force: true })
    }
    const look = () => {
      try {
        const woke = openedByPerson(opsNow(), start)
        if (woke.length === 0) return
        end()
        const all = listing(root, { state: 'all' })
        resolve({ ...all, comments: all.comments.filter((t) => woke.includes(t.id)) })
      } catch (e) {
        end()
        reject(e)
      }
    }
    const poll = setInterval(
      () => {
        try {
          const now = new Date()
          utimesSync(mine, now, now)
        } catch {}
        look()
      },
      Math.min(o.pollMs ?? 1000, 1000),
    )
    try {
      watcher = watch(join(root, 'versions'), (_, name) => {
        if (!name || name === 'comments.jsonl') look()
      })
      watcher.on('error', () => {})
    } catch {}
    o.signal?.addEventListener('abort', () => {
      end()
      reject(new Error('stopped waiting'))
    })
  })
}
