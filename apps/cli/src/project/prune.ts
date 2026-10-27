import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { hashInputs } from './bakes.ts'
import {
  type Files,
  head,
  log,
  type Revision,
  readRevision,
  removeFrozen,
  unusedFrozen,
} from './revisions.ts'

/**
 * `shaderera prune`: removes the saved revisions nobody names, and the objects only they held.
 *
 * Kept: the head; every revision with a label; every revision a job in `versions/jobs/` names;
 * every revision whose files a bake stamp was made from; every revision `versions/comments.jsonl`
 * names (ADR 0025); every revision whose frozen copy under `.shaderera/revisions/` a live process
 * uses or used in the last `GRACE_MS` (a render may be running from it); an unlisted revision (a
 * tree a studio page framed, revisions.ts `store`) stored in the last `GRACE_MS`; and the last
 * `keep` saves, which never count an unlisted one.
 * Every other frozen copy is removed: a render makes it again from the revision. Removed: the other revisions' files (their log
 * lines stay, and `versions/pruned.jsonl` says they were pruned), then every object no revision
 * still there names, unless it was used in the last `GRACE_MS` (a save beside the prune may be
 * about to name it: save marks each object it finds already stored). There is no lock: a save
 * that marks an object in the instant between the prune checking it and removing it loses it, and
 * its revision is refused as corrupt when read.
 *
 * When a job, a stamp or a revision cannot be read, nothing is removed: what it names is unknown.
 */

/** How long an object used by a save is never removed, though no revision names it yet. */
export const GRACE_MS = 10 * 60_000

export type Kept = { id: string; why: string[] }
export type Pruned = {
  /** The revisions removed (or, in a dry run, that would be), by id. */
  removed: string[]
  /** The objects removed (or that would be), by hash. */
  objects: string[]
  /** The frozen copies no live process uses that were removed (or would be), by revision id. */
  copies: string[]
  /** The revisions that could not be removed now (a file held open): the next prune removes them. */
  left: string[]
  /** The bytes those revisions and objects held. */
  bytes: number
  kept: Kept[]
}

const HEX16 = /^[0-9a-f]{16}$/
const HEX64 = /^[0-9a-f]{64}$/

const refuse = (what: string, e: unknown): never => {
  throw new Error(
    `${what} cannot be read (${(e as Error).message ?? e}); prune cannot tell what it names, so nothing was removed.`,
  )
}

/** The `.json` files of a folder of `versions/`, parsed, or a refusal naming the one that is not. */
const jsonFiles = (root: string, folder: string, skip?: RegExp): [string, unknown][] => {
  const dir = join(root, 'versions', folder)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !skip?.test(f))
    .sort()
    .map((f) => {
      try {
        return [f, JSON.parse(readFileSync(join(dir, f), 'utf8'))] as [string, unknown]
      } catch (e) {
        return refuse(`versions/${folder}/${f}`, e)
      }
    })
}

const revisionIds = (root: string): string[] => {
  const dir = join(root, 'versions', 'revisions')
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => HEX16.test(f.slice(0, -5)) && f.endsWith('.json') && f.length === 21)
        .map((f) => f.slice(0, -5))
        .sort()
    : []
}

const readAll = (root: string): Map<string, Revision> =>
  new Map(
    revisionIds(root).map((id) => {
      try {
        return [id, readRevision(root, id)]
      } catch (e) {
        return refuse(`versions/revisions/${id}.json`, e)
      }
    }),
  )

const size = (file: string) => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** The bytes of the files in a folder, links not followed. */
export const folderSize = (dir: string): number => {
  try {
    return readdirSync(dir, { recursive: true })
      .map((p) => {
        try {
          const s = lstatSync(join(dir, String(p)))
          return s.isFile() ? s.size : 0
        } catch {
          return 0
        }
      })
      .reduce((a, b) => a + b, 0)
  } catch {
    return 0
  }
}

/** Removes (or with `dryRun`, lists) the revisions nobody names and the objects only they held. */
export const prune = (
  root: string,
  o: {
    keep: number
    dryRun?: boolean
    now?: () => number
    /** Removes one file (a test's stands in for a file held open). */
    remove?: (file: string) => void
  },
): Pruned => {
  const remove = o.remove ?? ((file: string) => rmSync(file, { force: true }))
  if (!Number.isInteger(o.keep) || o.keep < 0)
    throw new Error(`--keep is a number of saves, 0 or more, not ${o.keep}.`)
  const now = o.now ?? Date.now
  const versions = join(root, 'versions')
  const revisions = readAll(root)
  const entries = log(root)
  const why = new Map<string, string[]>()
  const keep = (id: unknown, reason: string) => {
    if (typeof id !== 'string' || !revisions.has(id)) return
    const reasons = why.get(id) ?? []
    if (!reasons.includes(reason)) reasons.push(reason)
    why.set(id, reasons)
  }

  keep(head(root), 'the head')
  for (const [id, r] of revisions) if (r.label) keep(id, 'a label')
  for (const e of entries) if (e.label) keep(e.id, 'a label')
  for (const [file, job] of jsonFiles(root, 'jobs', /\.host\.json$/)) {
    const { name, revision } = (job ?? {}) as { name?: unknown; revision?: unknown }
    if (typeof revision !== 'string' || !HEX16.test(revision))
      refuse(`versions/jobs/${file}`, new Error('it names no revision'))
    keep(revision, `job ${typeof name === 'string' ? name : file.slice(0, -5)}`)
  }
  // A bake stamp names the inputs' files it was made from: every revision that has them as made.
  const stamped = new Set<string>()
  for (const [file, stamp] of jsonFiles(root, 'bakes')) {
    const s = (stamp ?? {}) as {
      name?: unknown
      bake?: { inputs?: unknown }
      inputs?: { hash?: unknown; files?: unknown }
    }
    const inputs = s.bake?.inputs
    if (!Array.isArray(inputs) || typeof s.inputs?.hash !== 'string')
      refuse(`versions/bakes/${file}`, new Error('it is not a bake stamp'))
    for (const hash of Object.values((s.inputs?.files ?? {}) as Files)) stamped.add(hash)
    for (const [id, r] of revisions) {
      let made: string | undefined
      try {
        made = hashInputs(root, inputs as string[], r.files).hash
      } catch {}
      if (made === s.inputs?.hash)
        keep(id, `bake ${typeof s.name === 'string' ? s.name : file.slice(0, -5)}`)
    }
  }
  // Comments name revisions (`revision`, `fixedIn`): every revision id in the file is kept.
  const comments = join(versions, 'comments.jsonl')
  if (existsSync(comments))
    for (const [, id] of readFileSync(comments, 'utf8').matchAll(/"([0-9a-f]{16})"/g))
      keep(id, 'a comment')
  const frozen = join(root, '.shaderera', 'revisions')
  const unused = unusedFrozen(root)
  const copies = unused.filter((c) => now() - c.used >= GRACE_MS).map((c) => c.id)
  if (existsSync(frozen))
    for (const id of readdirSync(frozen))
      if (HEX16.test(id) && !copies.includes(id))
        keep(
          id,
          unused.some((c) => c.id === id) ? 'a frozen copy used just now' : 'a frozen copy in use',
        )
  // An unlisted revision (a tree a studio page framed) stored just now: a comment on it may be
  // being written. Older ones go unless something above names them, whatever `keep` says.
  const logged = new Set(entries.map((e) => e.id))
  for (const [id, r] of revisions)
    if (!logged.has(id) && now() - Date.parse(r.created) < GRACE_MS) keep(id, 'framed just now')
  const saves: string[] = []
  for (const e of [...entries].reverse()) {
    if (saves.length >= o.keep) break
    if (e.action === 'save' && revisions.has(e.id) && !saves.includes(e.id)) saves.push(e.id)
  }
  for (const id of saves)
    keep(id, o.keep === 1 ? 'the last save' : `one of the last ${o.keep} saves`)

  let removed = [...revisions.keys()].filter((id) => !why.has(id))
  // The objects no revision left names, and no save used just now.
  const unnamed = (left: Iterable<Files>) => {
    const named = new Set(stamped)
    for (const files of left) for (const hash of Object.values(files)) named.add(hash)
    const dir = join(versions, 'objects')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((h) => HEX64.test(h) && !named.has(h))
      .filter((h) => {
        try {
          return now() - statSync(join(dir, h)).mtimeMs >= GRACE_MS
        } catch {
          return false
        }
      })
      .sort()
  }
  const revisionFile = (id: string) => join(versions, 'revisions', `${id}.json`)
  const objectFile = (hash: string) => join(versions, 'objects', hash)
  const kept: Kept[] = [...why].map(([id, reasons]) => ({ id, why: reasons }))
  kept.sort((a, b) => (a.id < b.id ? -1 : 1))

  if (o.dryRun) {
    const objects = unnamed([...revisions].filter(([id]) => why.has(id)).map(([, r]) => r.files))
    const bytes =
      removed.reduce((n, id) => n + size(revisionFile(id)), 0) +
      objects.reduce((n, h) => n + size(objectFile(h)), 0) +
      copies.reduce((n, id) => n + folderSize(join(frozen, id)), 0)
    return { removed, objects, copies, bytes, kept, left: [] }
  }

  // Anything saved, restored or undone since the prune began is kept.
  const since = new Set(
    log(root)
      .slice(entries.length)
      .map((e) => e.id),
  )
  removed = removed.filter((id) => !since.has(id))
  let bytes = 0
  // The unused frozen copies, checked again just before each goes: one a render took since stays.
  const gone: string[] = []
  for (const id of copies) {
    const again = unusedFrozen(root).find((c) => c.id === id)
    if (!again || now() - again.used < GRACE_MS) continue
    const n = folderSize(join(frozen, id))
    if (removeFrozen(root, id)) {
      bytes += n
      gone.push(id)
    }
  }
  if (removed.length > 0) {
    const at = new Date(now()).toISOString()
    appendFileSync(
      join(versions, 'pruned.jsonl'),
      removed.map((id) => `${JSON.stringify({ at, id })}\n`).join(''),
    )
  }
  // A file held open now (an antivirus on Windows) stays; its objects stay too, and the next
  // prune removes it.
  const busy: string[] = []
  for (const id of removed) {
    const n = size(revisionFile(id))
    try {
      remove(revisionFile(id))
      bytes += n
    } catch {
      busy.push(id)
    }
  }
  removed = removed.filter((id) => !busy.includes(id))
  // The revisions there now, a save's new one too, name the objects that stay.
  const objects: string[] = []
  let left: Files[]
  try {
    left = [...readAll(root).values()].map((r) => r.files)
  } catch {
    // A revision unreadable now (being written by hand?): every object stays.
    return { removed, objects, copies: gone, bytes, kept, left: busy }
  }
  for (const hash of unnamed(left)) {
    const file = objectFile(hash)
    const n = size(file)
    try {
      if (now() - statSync(file).mtimeMs < GRACE_MS) continue
      rmSync(file)
      bytes += n
      objects.push(hash)
    } catch {}
  }
  return { removed, objects, copies: gone, bytes, kept, left: busy }
}
