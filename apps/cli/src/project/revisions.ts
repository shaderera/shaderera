import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/**
 * Saved revisions of a project's source: content-addressed copies of its files under
 * `versions/`, so a version can be compared, restored, undone and rendered exactly as saved.
 *
 *   versions/objects/<sha256>     file contents, stored once
 *   versions/revisions/<id>.json  one revision: its files (path → sha256), parent, label
 *   versions/log.jsonl            what happened, in order: save, restore, undo
 *
 * A revision's id is the hash of its file list, so the same tree always has the same id.
 *
 * Links (symbolic links and junctions) are never followed or stored: a link's target can be
 * outside the project, and a revision holds the project's own files. Nothing is ever written
 * through a link either: a restore, undo or frozen copy refuses a path that passes through
 * one. Every path a revision names is checked, and every object is checked against its hash when
 * it is read.
 */

export type Files = { [path: string]: string }
export type By = 'person' | 'studio' | 'agent' | 'cli'
export type Revision = {
  id: string
  parent: string | null
  created: string
  by: By
  label?: string
  note?: string
  files: Files
}
export type LogEntry = {
  at: string
  action: 'save' | 'restore' | 'undo'
  id: string
  by: By
  label?: string
}

/** Never part of a revision, at the root: builds, renders, the store itself, tool folders. */
const ROOT_ONLY = new Set(['out', '.shaderera', 'versions', '.claude', 'NVIDIA Corporation'])
/** Never part of a revision, at any depth: installs and git's own folders. */
const ANYWHERE = new Set(['node_modules', '.git'])
/**
 * Never part of a revision, at any depth: files that hold secrets (env files, direnv's, Wrangler's,
 * npm's and curl's credentials, MCP configs with keys, private keys), so neither a share nor a
 * handoff can carry one.
 */
export const SECRET =
  /^(\.env(\..+)?|\.envrc|\.dev\.vars(\..+)?|\.npmrc|\.netrc|\.mcp\.json|.+\.(pem|key|p12|pfx))$/
/** writeAtomic's temporary files, which another process may be about to move into place. */
const TEMPORARY = /\.\d+\.tmp$/

const store = (root: string) => join(root, 'versions')
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
export const slash = (p: string) => p.split(sep).join('/')

/**
 * A file's sha256, read in pieces so a file of any size hashes; with `to`, also copied there as
 * it is read, so the copy is exactly what was hashed.
 */
export const hashFile = (file: string, to?: string): string => {
  const h = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1 << 20)
  const fd = openSync(file, 'r')
  const out = to === undefined ? null : openSync(to, 'w')
  try {
    for (;;) {
      const n = readSync(fd, buffer)
      if (n === 0) break
      h.update(buffer.subarray(0, n))
      if (out !== null) writeSync(out, buffer, 0, n)
    }
  } finally {
    closeSync(fd)
    if (out !== null) closeSync(out)
  }
  return h.digest('hex')
}

/**
 * The project's files as they are now: path (with `/`) → sha256. Links and secrets are skipped,
 * and listed in `left.links` and `left.secrets` when they are given. `keep` narrows it to some
 * paths (a bake's inputs): a folder it refuses is not entered, a file it refuses not hashed.
 * `hash` hashes a file (a watcher's, which remembers the files it hashed, studio/bridge.ts).
 */
export const scan = (
  root: string,
  left: { links?: string[]; secrets?: string[] } = {},
  keep: (path: string, folder: boolean) => boolean = () => true,
  hash: (file: string) => string = hashFile,
): Files => {
  const files: Files = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (ANYWHERE.has(name) || TEMPORARY.test(name) || (dir === root && ROOT_ONLY.has(name)))
        continue
      const full = join(dir, name)
      const path = slash(relative(root, full))
      const s = lstatSync(full)
      if (s.isSymbolicLink()) left.links?.push(path)
      else if (s.isFile() && SECRET.test(name)) left.secrets?.push(path)
      else if (s.isDirectory()) keep(path, true) && walk(full)
      else if (s.isFile() && keep(path, false)) files[path] = hash(full)
    }
  }
  walk(root)
  return files
}

/** A path a revision may name: relative, `/`-separated, no `.`, `..` or empty part, not ignored. */
export const validPath = (path: string) => {
  const parts = path.split('/')
  return (
    !/[\\:\0]/.test(path) &&
    parts.every((p) => p !== '' && p !== '.' && p !== '..' && !ANYWHERE.has(p)) &&
    !ROOT_ONLY.has(parts[0] as string)
  )
}

/**
 * Where `path` is under `root`, refusing a path a revision may not name or one that passes
 * through a link, so a write can never leave the project.
 */
const inside = (root: string, path: string): string => {
  if (!validPath(path)) throw new Error(`Refusing the path ${JSON.stringify(path)}.`)
  let at = root
  for (const part of path.split('/')) {
    at = join(at, part)
    let link: boolean
    try {
      link = lstatSync(at).isSymbolicLink()
    } catch {
      break
    }
    if (link)
      throw new Error(
        `Refusing to write ${path}: ${slash(relative(root, at))} is a link, and a revision never writes through links.`,
      )
  }
  return join(root, ...path.split('/'))
}

/** The id of a file list: the first 16 hex digits of the hash of its sorted entries. */
export const treeId = (files: Files): string =>
  createHash('sha256')
    .update(
      Object.keys(files)
        .sort()
        .map((p) => `${p}\0${files[p]}\n`)
        .join(''),
    )
    .digest('hex')
    .slice(0, 16)

/** A revision, checked: its id is the hash of its files, and every path and hash is well formed. */
export const readRevision = (root: string, id: string): Revision => {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`No revision ${id}.`)
  const file = join(store(root), 'revisions', `${id}.json`)
  if (!existsSync(file)) throw new Error(`No revision ${id}.`)
  const revision = JSON.parse(readFileSync(file, 'utf8')) as Revision
  const files = revision.files ?? {}
  const bad = Object.entries(files).find(([p, h]) => !validPath(p) || !/^[0-9a-f]{64}$/.test(h))
  if (bad) throw new Error(`Revision ${id} names an invalid file: ${JSON.stringify(bad[0])}.`)
  if (revision.id !== id || treeId(files) !== id)
    throw new Error(`Revision ${id} does not match its files: versions/ was changed by hand.`)
  return revision
}

export const log = (root: string): LogEntry[] => {
  const file = join(store(root), 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry)
}

/** The revision the working tree was last saved as or restored to, if any. */
export const head = (root: string): string | null => log(root).at(-1)?.id ?? null

const append = (root: string, entry: Omit<LogEntry, 'at'>) => {
  mkdirSync(store(root), { recursive: true })
  appendFileSync(
    join(store(root), 'log.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  )
}

/** Writes a file through a temporary name, so a reader never sees half of it. */
const writeAtomic = (file: string, data: Uint8Array | string) => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

/**
 * Saves the working tree as a revision and returns it; the same files return the revision that
 * holds them, `existing`, with its own label and note (a new label is only logged, when given or
 * when it is not already the head).
 */
export const save = (
  root: string,
  o: { by: By; label?: string; note?: string } = { by: 'person' },
): Revision & { existing: boolean } => {
  const files = scan(root)
  const id = treeId(files)
  const objects = join(store(root), 'objects')
  mkdirSync(objects, { recursive: true })
  for (const [path, hash] of Object.entries(files)) {
    const object = join(objects, hash)
    if (existsSync(object)) continue
    // Copied as it is hashed: a file edited since the scan is never stored under the old hash.
    const tmp = `${object}.${process.pid}.tmp`
    if (hashFile(join(root, path), tmp) !== hash) {
      rmSync(tmp, { force: true })
      throw new Error(`${path} changed during save; save again.`)
    }
    renameSync(tmp, object)
  }
  const file = join(store(root), 'revisions', `${id}.json`)
  const parent = head(root)
  const existing = existsSync(file)
  let revision: Revision
  if (existing) revision = readRevision(root, id)
  else {
    revision = {
      id,
      parent: parent === id ? null : parent,
      created: new Date().toISOString(),
      by: o.by,
      ...(o.label ? { label: o.label } : {}),
      ...(o.note ? { note: o.note } : {}),
      files,
    }
    writeAtomic(file, `${JSON.stringify(revision, null, 1)}\n`)
  }
  if (parent !== id || o.label) append(root, { action: 'save', id, by: o.by, label: o.label })
  return { ...revision, existing }
}

/** A stored file's contents, checked against its hash. */
export const readObject = (root: string, hash: string): Buffer => {
  const data = readFileSync(join(store(root), 'objects', hash))
  if (sha256(data) !== hash) throw new Error(`versions/objects/${hash} is corrupt.`)
  return data
}

/**
 * Makes a folder (the working tree by default) equal a revision: writes its files and removes the
 * files it does not have. Every path and every object is checked before anything is written.
 */
const checkout = (root: string, target: Revision, dir = root) => {
  const now = existsSync(dir) ? scan(dir) : {}
  const corrupt = (hash: string) => new Error(`versions/objects/${hash} is corrupt.`)
  const writes = Object.entries(target.files)
    .filter(([path, hash]) => now[path] !== hash)
    .map(([path, hash]) => {
      const object = join(store(root), 'objects', hash)
      if (!existsSync(object) || hashFile(object) !== hash) throw corrupt(hash)
      return [inside(dir, path), object, hash] as const
    })
  const removes = Object.keys(now)
    .filter((path) => !(path in target.files))
    .map((path) => inside(dir, path))
  for (const [file, object, hash] of writes) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    if (hashFile(object, tmp) !== hash) {
      rmSync(tmp, { force: true })
      throw corrupt(hash)
    }
    renameSync(tmp, file)
  }
  for (const file of removes) rmSync(file, { force: true })
}

/**
 * Restores a revision. The working tree is saved first, so nothing unsaved is lost: it stays
 * reachable as its own revision.
 */
export const restore = (root: string, id: string, by: By = 'person'): Revision => {
  const target = readRevision(root, id)
  save(root, { by })
  checkout(root, target)
  append(root, { action: 'restore', id, by })
  return target
}

/**
 * Returns to the previous complete revision (the working tree is saved first, so unsaved edits are
 * kept as a revision): after a restore or an undo, the revision that was the head before it;
 * otherwise the parent of the working tree's revision. Throws when there is nothing to undo.
 */
export const undo = (root: string, by: By = 'person'): Revision => {
  const current = save(root, { by })
  const [before, last] = log(root).slice(-2)
  const back =
    last && last.action !== 'save' && before && before.id !== current.id
      ? before.id
      : current.parent
  if (!back) throw new Error('Nothing to undo: this is the first saved revision.')
  const target = readRevision(root, back)
  checkout(root, target)
  append(root, { action: 'undo', id: target.id, by })
  return target
}

/** Which files differ between two revisions (or a revision and the working tree). */
export const changedFiles = (
  a: Files,
  b: Files,
): { added: string[]; removed: string[]; changed: string[] } => ({
  added: Object.keys(b).filter((p) => !(p in a)),
  removed: Object.keys(a).filter((p) => !(p in b)),
  changed: Object.keys(a).filter((p) => p in b && a[p] !== b[p]),
})

/** A file's contents in a revision. */
export const fileAt = (root: string, id: string, path: string): Buffer | null => {
  const hash = readRevision(root, id).files[path]
  return hash ? readObject(root, hash) : null
}

/**
 * A revision's files under `.shaderera/revisions/<id>/`, a frozen copy that a render job builds
 * and renders from while the working tree keeps changing. It sits inside the project, so imports
 * still resolve from the project's node_modules. Each call checks the copy against the revision
 * and repairs what differs, so an edit to the copy never renders under the revision's id.
 */
export const materialize = (root: string, id: string): string => {
  const revision = readRevision(root, id)
  const dir = join(root, '.shaderera', 'revisions', id)
  checkout(root, revision, dir)
  return dir
}
