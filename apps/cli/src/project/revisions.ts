import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
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
 *   versions/pruned.jsonl         the revisions `shaderera prune` removed (project/prune.ts)
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

// Every name below is matched in any case, on every OS: NTFS and APFS take `.ENV` for `.env` and
// `OUT` for `out`, and a file really named `.ENV` holds secrets as well.
/** Never part of a revision, at the root: builds, renders, the store itself, tool folders. */
const ROOT_ONLY = new Set(['out', '.shaderera', 'versions', '.claude', 'nvidia corporation'])
/** Never part of a revision, at any depth: installs and git's own folders. */
const ANYWHERE = new Set(['node_modules', '.git'])
const rootOnly = (name: string) => ROOT_ONLY.has(name.toLowerCase())
const anywhere = (name: string) => ANYWHERE.has(name.toLowerCase())
/**
 * Never part of a revision, at any depth: files that hold secrets (env files, direnv's, Wrangler's,
 * npm's and curl's credentials, private keys), so neither a share nor a handoff can carry one.
 */
export const SECRET =
  /^(\.env(\..+)?|\.envrc|\.dev\.vars(\..+)?|\.npmrc|\.netrc|.+\.(pem|key|p12|pfx))$/i

/** Shaderera's own MCP server, as a new project's `.mcp.json` names it: `shaderera` or `shaderera@<version>`. */
const SHADERERA_PACKAGE = /^shaderera(@[\w.+-]+)?$/

const isEmptyObject = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0

/** One server that is exactly Shaderera's own: `npx -y shaderera mcp`, with at most an empty env or headers. */
const isShadereraServer = (s: unknown): boolean => {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return false
  const { command, args, ...rest } = s as Record<string, unknown>
  return (
    command === 'npx' &&
    Array.isArray(args) &&
    args.length === 3 &&
    args[0] === '-y' &&
    typeof args[1] === 'string' &&
    SHADERERA_PACKAGE.test(args[1]) &&
    args[2] === 'mcp' &&
    Object.entries(rest).every(([k, v]) => (k === 'env' || k === 'headers') && isEmptyObject(v))
  )
}

/**
 * An MCP config (`.mcp.json`) is a revision's only when it parses and every server in it is
 * Shaderera's own, as a new project's is. Keys can hide anywhere else (env, headers, args, a url's
 * query or user:pass@), so any other config is kept out as a secret.
 */
export const mcpIsShaderera = (file: string): boolean => {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return false
    const { mcpServers, ...rest } = config as Record<string, unknown>
    if (Object.keys(rest).length > 0) return false
    if (typeof mcpServers !== 'object' || mcpServers === null || Array.isArray(mcpServers))
      return false
    return Object.values(mcpServers).every(isShadereraServer)
  } catch {
    return false
  }
}

/** A file a revision never holds because it holds secrets: SECRET by name, or an MCP config other than Shaderera's own. */
export const isSecret = (file: string, name: string): boolean =>
  SECRET.test(name) || (name.toLowerCase() === '.mcp.json' && !mcpIsShaderera(file))
/** writeAtomic's temporary files, which another process may be about to move into place. */
const TEMPORARY = /\.\d+\.tmp$/

const versionsOf = (root: string) => join(root, 'versions')
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
      if (anywhere(name) || TEMPORARY.test(name) || (dir === root && rootOnly(name))) continue
      const full = join(dir, name)
      const path = slash(relative(root, full))
      const s = lstatSync(full)
      if (s.isSymbolicLink()) left.links?.push(path)
      else if (s.isFile() && isSecret(full, name)) left.secrets?.push(path)
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
    parts.every((p) => p !== '' && p !== '.' && p !== '..' && !anywhere(p)) &&
    !rootOnly(parts[0] as string)
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

/** The ids `shaderera prune` removed, from `versions/pruned.jsonl` (a torn line is skipped). */
export const prunedIds = (root: string): Set<string> => {
  const file = join(versionsOf(root), 'pruned.jsonl')
  const ids = new Set<string>()
  if (!existsSync(file)) return ids
  for (const line of readFileSync(file, 'utf8').split('\n'))
    try {
      const { id } = JSON.parse(line) as { id?: unknown }
      if (typeof id === 'string') ids.add(id)
    } catch {}
  return ids
}

const wasPruned = (id: string) =>
  new Error(
    `Revision ${id} was pruned (shaderera prune): its files are no longer kept, so it cannot be restored, compared or rendered.`,
  )

/** A revision, checked: its id is the hash of its files, and every path and hash is well formed. */
export const readRevision = (root: string, id: string): Revision => {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`No revision ${id}.`)
  const file = join(versionsOf(root), 'revisions', `${id}.json`)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // Gone, or removed by a prune as it was read.
    throw prunedIds(root).has(id) ? wasPruned(id) : new Error(`No revision ${id}.`)
  }
  const revision = JSON.parse(text) as Revision
  const files = revision.files ?? {}
  const bad = Object.entries(files).find(([p, h]) => !validPath(p) || !/^[0-9a-f]{64}$/.test(h))
  if (bad) throw new Error(`Revision ${id} names an invalid file: ${JSON.stringify(bad[0])}.`)
  if (revision.id !== id || treeId(files) !== id)
    throw new Error(`Revision ${id} does not match its files: versions/ was changed by hand.`)
  return revision
}

export const log = (root: string): LogEntry[] => {
  const file = join(versionsOf(root), 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry)
}

/** The revision the working tree was last saved as or restored to, if any. */
export const head = (root: string): string | null => log(root).at(-1)?.id ?? null

const append = (root: string, entry: Omit<LogEntry, 'at'>) => {
  mkdirSync(versionsOf(root), { recursive: true })
  appendFileSync(
    join(versionsOf(root), 'log.jsonl'),
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

/** Where the project's own hasher remembers what it hashed: this machine's, never in a revision. */
const HASHES = join('.shaderera', 'hashes.json')
/** How close to the moment it was hashed a file's time must be for it to be hashed again. */
const RACY_NS = 2_000_000_000n

/**
 * A hasher for the project's files that hashes a file again only when its size, modification time
 * (in ns) or inode changed since it was last hashed, as git's index does; `write()` keeps what it
 * hashed in `.shaderera/hashes.json` for the next scan. A file modified within `RACY_NS` of the
 * moment it was hashed is hashed again, since an edit in that same tick would leave its size and
 * time as they were. A missing or unreadable file means every file is hashed.
 */
export const projectHasher = (root: string) => {
  const file = join(root, HASHES)
  type Entry = [size: string, mtime: string, ino: string, sha: string, hashed: string]
  let known: { [file: string]: Entry } = {}
  try {
    known = (JSON.parse(readFileSync(file, 'utf8')) as { files: typeof known }).files ?? {}
  } catch {}
  const seen: { [file: string]: Entry } = {}
  return {
    hash: (full: string): string => {
      const s = statSync(full, { bigint: true })
      const path = slash(relative(root, full))
      const was = known[path]
      if (
        was &&
        was[0] === String(s.size) &&
        was[1] === String(s.mtimeNs) &&
        was[2] === String(s.ino) &&
        s.mtimeNs + RACY_NS < BigInt(was[4])
      ) {
        seen[path] = was
        return was[3]
      }
      const hashed = BigInt(Date.now()) * 1_000_000n
      const sha = hashFile(full)
      seen[path] = [String(s.size), String(s.mtimeNs), String(s.ino), sha, String(hashed)]
      return sha
    },
    write: () => writeAtomic(file, JSON.stringify({ files: seen })),
  }
}

/** The project's files as they are now, hashing only those changed since the last scan of it. */
export const scanProject = (root: string, left?: Parameters<typeof scan>[1]): Files => {
  const hasher = projectHasher(root)
  const files = scan(root, left, undefined, hasher.hash)
  try {
    hasher.write()
  } catch {}
  return files
}

/**
 * Stores the working tree as a revision, its objects and its JSON, and returns it, without a line
 * in the log: `versions`, `undo` and `restore` never see it, and `prune` removes it unless a
 * comment, a job or a bake names it. The studio stores so each tree a page frames, for a comment
 * to name (decision 0025, point 5). The same files return the revision that holds them, `existing`.
 */
export const store = (
  root: string,
  o: { by: By; label?: string; note?: string } = { by: 'person' },
): Revision & { existing: boolean } => {
  const files = scanProject(root)
  const id = treeId(files)
  const objects = join(versionsOf(root), 'objects')
  mkdirSync(objects, { recursive: true })
  for (const [path, hash] of Object.entries(files)) {
    const object = join(objects, hash)
    // Already stored: marked used now, so a prune running beside this save keeps it (prune.ts).
    try {
      const now = new Date()
      utimesSync(object, now, now)
      continue
    } catch {}
    // Cloned and then hashed, or copied as it is hashed: a file edited since the scan is never
    // stored under the old hash. Read-only, so a frozen copy may link it (ADR 0029).
    const tmp = `${object}.${process.pid}.tmp`
    if ((clone(join(root, path), tmp) ? hashFile(tmp) : hashFile(join(root, path), tmp)) !== hash) {
      rmSync(tmp, { force: true })
      throw new Error(`${path} changed during save; save again.`)
    }
    chmodSync(tmp, 0o444)
    try {
      renameSync(tmp, object)
    } catch (e) {
      // A save beside this one stored it first (Windows refuses to rename over a read-only file).
      rmSync(tmp, { force: true })
      if (!existsSync(object)) throw e
    }
  }
  const file = join(versionsOf(root), 'revisions', `${id}.json`)
  const parent = head(root)
  const existing = existsSync(file)
  if (existing) return { ...readRevision(root, id), existing }
  const revision: Revision = {
    id,
    parent: parent === id ? null : parent,
    created: new Date().toISOString(),
    by: o.by,
    ...(o.label ? { label: o.label } : {}),
    ...(o.note ? { note: o.note } : {}),
    files,
  }
  writeAtomic(file, `${JSON.stringify(revision, null, 1)}\n`)
  return { ...revision, existing }
}

/**
 * Saves the working tree as a revision and returns it: stores it, and logs it. The same files
 * return the revision that holds them, `existing`, with its own label and note (a new label is
 * only logged, when given or when it is not already the head).
 */
export const save = (
  root: string,
  o: { by: By; label?: string; note?: string } = { by: 'person' },
): Revision & { existing: boolean } => {
  const revision = store(root, o)
  if (head(root) !== revision.id || o.label)
    append(root, { action: 'save', id: revision.id, by: o.by, label: o.label })
  return revision
}

/** A stored file's contents, checked against its hash. */
export const readObject = (root: string, hash: string): Buffer => {
  const data = readFileSync(join(versionsOf(root), 'objects', hash))
  if (sha256(data) !== hash) throw new Error(`versions/objects/${hash} is corrupt.`)
  return data
}

/** A copy-on-write copy, where the file system has them (APFS, btrfs, XFS): whether it made one. */
const clone = (from: string, to: string) => {
  try {
    copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  }
}

/**
 * Puts a checked object at `file` (ADR 0029): a clone, else with `link` (a frozen copy, never the
 * working tree) a hard link to the read-only object, else a copy hashed as it is written. False
 * when that copy is not `hash`.
 */
const place = (object: string, file: string, hash: string, link: boolean) => {
  const tmp = `${file}.${process.pid}.tmp`
  rmSync(tmp, { force: true })
  if (clone(object, tmp)) chmodSync(tmp, 0o644)
  else if (!(link && linked(object, tmp)) && hashFile(object, tmp) !== hash) {
    rmSync(tmp, { force: true })
    return false
  }
  try {
    renameSync(tmp, file)
  } catch {
    // Windows refuses to rename over a read-only file: the frozen file a link left.
    rmSync(file, { force: true })
    renameSync(tmp, file)
  }
  return true
}
const linked = (object: string, to: string) => {
  try {
    chmodSync(object, 0o444)
    linkSync(object, to)
    return true
  } catch {
    rmSync(to, { force: true })
    return false
  }
}

/**
 * Makes a folder (the working tree by default) equal a revision: writes its files and removes the
 * files it does not have. Every path and every object is checked before anything is written.
 */
const checkout = (root: string, target: Revision, dir = root, link = false) => {
  const now = existsSync(dir) ? scan(dir) : {}
  // An object a prune removed while this ran (its revision is listed pruned first) says so.
  const corrupt = (hash: string) =>
    prunedIds(root).has(target.id)
      ? wasPruned(target.id)
      : new Error(`versions/objects/${hash} is corrupt.`)
  const intact = (object: string, hash: string) => {
    try {
      return hashFile(object) === hash
    } catch {
      return false
    }
  }
  const writes = Object.entries(target.files)
    .filter(([path, hash]) => now[path] !== hash)
    .map(([path, hash]) => {
      const object = join(versionsOf(root), 'objects', hash)
      if (!intact(object, hash)) throw corrupt(hash)
      return [inside(dir, path), object, hash] as const
    })
  const removes = Object.keys(now)
    .filter((path) => !(path in target.files))
    .map((path) => inside(dir, path))
  for (const [file, object, hash] of writes) {
    mkdirSync(dirname(file), { recursive: true })
    if (!place(object, file, hash, link)) throw corrupt(hash)
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
  // Marked before it is written, so no trim or prune takes it from now on (removeFrozen).
  use(root, id)
  // A trim that moved the copy aside as this began (and gave it back, or could not) leaves files
  // missing or a write failing: checked out again until every file is there.
  let failed: unknown = new Error(`The frozen copy of ${id} could not be made.`)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      checkout(root, revision, dir, true)
      if (complete(root, revision, dir)) {
        touch(dir)
        return dir
      }
    } catch (e) {
      failed = e
    }
  }
  releaseFrozen(root, id)
  throw failed
}

/** Whether every file of a revision is in a folder at its object's size. */
const complete = (root: string, revision: Revision, dir: string) =>
  Object.entries(revision.files).every(([path, hash]) => {
    try {
      return (
        statSync(join(dir, ...path.split('/'))).size ===
        statSync(join(versionsOf(root), 'objects', hash)).size
      )
    } catch {
      return false
    }
  })

/**
 * Who uses a frozen copy: one empty file per process, `.shaderera/revisions/<id>.using/<pid>`,
 * and this process's own uses counted here, so a copy is never removed while a render uses it.
 * The folder goes with its last user (`sweepMarks`). A copy's modification time is its last use.
 */
const uses = new Map<string, { root: string; id: string; n: number }>()
const copiesDir = (root: string) => join(root, '.shaderera', 'revisions')
const usingDir = (root: string, id: string) => join(copiesDir(root), `${id}.using`)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const touch = (dir: string) => {
  try {
    const now = new Date()
    utimesSync(dir, now, now)
  } catch {}
}
/** This process's mark on a copy, its folder made again if a sweep took it just then. */
const mark = (root: string, id: string) => {
  for (let attempt = 0; ; attempt++) {
    mkdirSync(usingDir(root, id), { recursive: true })
    try {
      writeFileSync(join(usingDir(root, id), String(process.pid)), '')
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 2) throw e
    }
  }
}
/**
 * Removes every marks folder whose users have all gone: their dead marks, then the folder. A
 * folder a live process marks stays, and so does one marked between the read and the removal
 * (it is not empty then); a mark written just after finds no folder and makes it again (`mark`).
 */
const sweepMarks = (root: string) => {
  let names: string[]
  try {
    names = readdirSync(copiesDir(root))
  } catch {
    return
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}\.using$/.test(name)) continue
    const dir = join(copiesDir(root), name)
    try {
      const marks = readdirSync(dir)
      if (marks.some((p) => alive(Number(p)))) continue
      for (const p of marks) rmSync(join(dir, p), { force: true })
      rmdirSync(dir)
    } catch {}
  }
}
let hooked = false
const use = (root: string, id: string) => {
  const key = `${root}\0${id}`
  const u = uses.get(key) ?? { root, id, n: 0 }
  if (u.n === 0) mark(root, id)
  u.n++
  uses.set(key, u)
  if (!hooked) process.once('exit', releaseAll)
  hooked = true
}

/** How many frozen copies nobody uses are kept after a render: see `releaseFrozen`. */
export const KEEP_FROZEN = 1

/**
 * The frozen copies no live process uses, most recently used first, with their last use (ms).
 */
export const unusedFrozen = (root: string): { id: string; used: number }[] => {
  const dir = copiesDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /^[0-9a-f]{16}$/.test(n))
    .filter((id) => liveMarks(root, id).length === 0)
    .flatMap((id) => {
      try {
        return [{ id, used: statSync(join(dir, id)).mtimeMs }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.used - a.used)
}

/** Removes a frozen copy and its marks; false when a file in it is held open (Windows). */
export const removeFrozen = (root: string, id: string, o: { moved?: () => void } = {}): boolean => {
  const dir = join(copiesDir(root), id)
  // Moved aside in one step, then the marks read again: a process that marked the copy before
  // the move gets it back; one that marks it after finds no copy and makes it again.
  const aside = join(copiesDir(root), `${id}.removing-${process.pid}-${Date.now()}`)
  try {
    renameSync(dir, aside)
  } catch {
    return false
  }
  o.moved?.()
  if (liveMarks(root, id).length > 0) {
    try {
      renameSync(aside, dir)
      return false
    } catch {
      // It already began a new copy there: that one repairs itself (materialize), and this goes.
    }
  }
  try {
    rmSync(aside, { recursive: true, force: true })
  } catch {}
  // The marks folder goes only when empty: another process's mark is never removed.
  try {
    rmdirSync(usingDir(root, id))
  } catch {}
  return !existsSync(aside)
}

/** The processes that mark a copy and still run. */
const liveMarks = (root: string, id: string) => {
  try {
    return readdirSync(usingDir(root, id)).filter((p) => alive(Number(p)))
  } catch {
    return []
  }
}

/** Removes this process's mark on a copy, marks it used now, and trims the unused copies. */
const drop = (root: string, id: string) => {
  try {
    rmSync(join(usingDir(root, id), String(process.pid)), { force: true })
  } catch {}
  touch(join(copiesDir(root), id))
  sweepMarks(root)
  for (const old of unusedFrozen(root).slice(KEEP_FROZEN)) removeFrozen(root, old.id)
  // Copies moved aside by a removal that could not finish (a file held open), when that process
  // is gone or is this one.
  try {
    for (const name of readdirSync(copiesDir(root))) {
      const m = /^[0-9a-f]{16}\.removing-(\d+)-\d+$/.exec(name)
      if (m && (Number(m[1]) === process.pid || !alive(Number(m[1]))))
        rmSync(join(copiesDir(root), name), { recursive: true, force: true })
    }
  } catch {}
}
const releaseAll = () => {
  for (const { root, id } of uses.values()) drop(root, id)
  uses.clear()
}

/**
 * Ends one use of a revision's frozen copy (a render from it ended). The copy stays, so the next
 * render of the revision rewrites only what differs; of the copies no live process uses, the
 * `KEEP_FROZEN` most recently used are kept and the older ones removed (`materialize` makes one
 * again when a render needs it). A process that exits with uses left releases them the same way:
 * `plan`, `assemble`, `reexport`, `deliver` and `handoff` open jobs only as their own CLI process,
 * so they release on exit; the MCP server, which lives on, releases after each export.
 *
 * A mark is live while a process with its pid runs. On Windows a pid can be reused: a mark whose
 * render died and whose pid another program took holds the copy until that program ends (its
 * start time is not read: that would mean a process listing per check).
 */
export const releaseFrozen = (root: string, id: string) => {
  const key = `${root}\0${id}`
  const u = uses.get(key)
  if (!u) return
  if (--u.n > 0) return
  uses.delete(key)
  drop(root, id)
}
