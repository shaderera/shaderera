// The project's activity (decision 0025, point 6): what the CLI, the agent (MCP) and the studio
// did, for the studio to show. Local and lossy: `.shaderera/` is this machine's cache, never in a
// revision, so share never sends it, and telemetry never reads it.
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
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Finding } from '../cli/findings.ts'

/** The findings of a command as an entry carries them: counts by severity, the first messages. */
export type Summary = { error: number; warning: number; info: number; messages: string[] }

export type EntryInput =
  | {
      kind: 'command'
      command: string
      args?: string[]
      exitCode: number
      ok: boolean
      summary: Summary
    }
  | { kind: 'tool'; tool: string; ok: boolean; ms: number; summary?: Summary }
  | { kind: 'note'; text: string; comment?: string }

export type Entry = EntryInput & {
  id: string
  at: string
  /** `agent` for MCP, `cli` for the CLI, `studio` for the bridge. */
  by: 'agent' | 'cli' | 'studio'
  /** The entry's image, relative to the project: `.shaderera/activity/<id>.png`. */
  image?: string
}

/** The log rotates past this many bytes, so it and its one older file hold at most twice it. */
export const ROTATE = 1 << 20
/**
 * An image over `bytes` is left out of its entry; past `count` images, the oldest go: at most
 * 100 MB under `.shaderera/activity/`. 2 MB holds a 1024 px render_frame and a contact sheet; the
 * studio shows the latest few.
 */
export const IMAGES = { bytes: 2 << 20, count: 50 }
/** An image younger than this may be another process's whose line is not written yet. */
const SETTLING = 60_000
/** A message as long as a summary keeps it. */
const MESSAGE = 300

const dirOf = (root: string) => join(root, '.shaderera')
const logOf = (root: string) => join(dirOf(root), 'activity.jsonl')
const olderOf = (root: string) => join(dirOf(root), 'activity.1.jsonl')
const imagesOf = (root: string) => join(dirOf(root), 'activity')

let made = 0
/**
 * Sortable by time, then unique: base-36 milliseconds, this process's count (entries of one
 * millisecond keep their order) and 4 random bytes (another process's).
 */
const newId = () =>
  `${Date.now().toString(36)}${(made++ % 36 ** 4).toString(36).padStart(4, '0')}-${randomBytes(4).toString('hex')}`

/** Counts by severity and the first three messages, each at most 300 characters. */
export const summaryOf = (findings: readonly Finding[]): Summary => {
  const count = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length
  return {
    error: count('error'),
    warning: count('warning'),
    info: count('info'),
    messages: findings.slice(0, 3).map((f) => f.message.slice(0, MESSAGE)),
  }
}

/** The entries in one file; a line that does not parse (a torn last one) is skipped. */
const read = (file: string): Entry[] => {
  if (!existsSync(file)) return []
  const entries: Entry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      entries.push(JSON.parse(line) as Entry)
    } catch {
      // Torn: another writer's line half written, or a crash.
    }
  }
  return entries
}

/**
 * Before a line that would take the log past ROTATE: the log becomes the older file, and the
 * images of the entries the older file held go with it. Two processes rotating at once may drop
 * a full older file for a short one: its entries are lost (activity is lossy), and their images,
 * named by no entry, go at the next rotation once a minute old (younger, it may be another
 * process's whose line is coming).
 */
const rotate = (root: string, adding: number) => {
  const log = logOf(root)
  if (!existsSync(log) || statSync(log).size + adding <= ROTATE) return
  const dropped = read(olderOf(root)).map((e) => e.image)
  renameSync(log, olderOf(root))
  for (const image of dropped) if (image) rmSync(join(root, image), { force: true })
  if (!existsSync(imagesOf(root))) return
  const named = new Set(read(olderOf(root)).map((e) => e.image))
  const now = Date.now()
  for (const name of readdirSync(imagesOf(root))) {
    const file = join(imagesOf(root), name)
    if (!named.has(`.shaderera/activity/${name}`) && now - statSync(file).mtimeMs > SETTLING)
      rmSync(file, { force: true })
  }
}

/** Past IMAGES.count, the oldest images go (their names sort by time). */
const capImages = (root: string) => {
  const names = readdirSync(imagesOf(root)).sort()
  for (const name of names.slice(0, Math.max(0, names.length - IMAGES.count)))
    rmSync(join(imagesOf(root), name), { force: true })
}

/**
 * Appends an entry to `.shaderera/activity.jsonl` (`id` and `at` filled in), its PNG under
 * `.shaderera/activity/<id>.png` when one is given within IMAGES.bytes. Gives the entry, or
 * undefined when it could not be written: activity never changes what a command does.
 */
export const record = (
  root: string,
  entry: EntryInput & { by: Entry['by'] },
  png?: Uint8Array,
): Entry | undefined => {
  let image: string | undefined
  try {
    const id = newId()
    const keep = png && png.length <= IMAGES.bytes
    const written: Entry = {
      id,
      at: new Date().toISOString(),
      ...entry,
      ...(keep ? { image: `.shaderera/activity/${id}.png` } : {}),
    }
    const line = `${JSON.stringify(written)}\n`
    mkdirSync(dirOf(root), { recursive: true })
    rotate(root, Buffer.byteLength(line))
    if (keep) {
      mkdirSync(imagesOf(root), { recursive: true })
      image = join(imagesOf(root), `${id}.png`)
      writeFileSync(image, png)
      capImages(root)
    }
    // One write of one line: concurrent writers append whole lines.
    appendFileSync(logOf(root), line)
    return written
  } catch {
    // An image whose line was not written is no one's.
    if (image) rmSync(image, { force: true })
    return undefined
  }
}

/** The last `n` entries, oldest first, across the log and its older file. */
export const tail = (root: string, n: number): Entry[] => {
  try {
    return [...read(olderOf(root)), ...read(logOf(root))].slice(-n)
  } catch {
    return []
  }
}

/** The longest note: as long as a comment (decision 0025). */
export const NOTE = 4000

/** The image a command made for its entry (`still --sheet`), taken by recordCommand. */
let madeImage: string | undefined
/** Names the image the running command made, for its activity entry. */
export const activityImage = (file: string) => {
  madeImage = file
}

/**
 * The project a command runs in: the folder its `--root` names, or the working directory, or the
 * nearest one above with a shaderera.json; undefined outside a project.
 */
export const projectRootOf = (argv: readonly string[]): string | undefined => {
  const at = argv.findIndex((a) => a === '--root' || a.startsWith('--root='))
  const given = at < 0 ? undefined : argv[at]?.includes('=') ? argv[at]?.slice(7) : argv[at + 1]
  let dir = resolve(given ?? process.cwd())
  while (!existsSync(join(dir, 'shaderera.json'))) {
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return dir
}

/**
 * What keeps secrets out of the activity, in one place: `login` and `logout` are never recorded,
 * and a flag whose name looks like a credential has its value written as `***`.
 */
const SECRET_COMMANDS = new Set(['login', 'logout'])
const SECRET_FLAG = /token|secret|key|pass|auth|bearer|credential/i
/** A URL's user and password: `https://user:pass@host`. */
const USERINFO = /([a-z][\w+.-]*:\/\/)[^/@\s]+@/gi

/**
 * `--token t` and `--token=t` as `--token ***` and `--token=***`, a URL's user and password as
 * `https://***@host`; other args as they are.
 */
export const redact = (args: readonly string[]): string[] =>
  args.map((a, i) => {
    const flag = /^--?([^=]+)=/.exec(a)
    if (flag && SECRET_FLAG.test(flag[1] as string)) return `${a.slice(0, a.indexOf('='))}=***`
    const before = args[i - 1]
    if (!a.startsWith('-') && before && /^--?[^=]+$/.test(before) && SECRET_FLAG.test(before))
      return '***'
    return a.replace(USERINFO, '$1***@')
  })

/**
 * A command's entry (`by: cli`), from its exit code and findings, with the image it named
 * (activityImage). Nothing outside a project; never throws.
 */
export const recordCommand = (o: {
  argv: readonly string[]
  exitCode: number
  findings: readonly Finding[]
}) => {
  const file = madeImage
  madeImage = undefined
  try {
    const root = projectRootOf(o.argv)
    if (!root) return
    const [command = '', ...args] = o.argv
    if (SECRET_COMMANDS.has(command)) return
    const png = file && statSync(file).size <= IMAGES.bytes ? readFileSync(file) : undefined
    record(
      root,
      {
        by: 'cli',
        kind: 'command',
        command,
        args: redact(args)
          .slice(0, 20)
          .map((a) => a.slice(0, 200)),
        exitCode: o.exitCode,
        ok: o.exitCode === 0,
        summary: summaryOf(o.findings),
      },
      png,
    )
  } catch {
    // Activity never changes what a command does.
  }
}
