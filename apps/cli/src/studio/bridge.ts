// The studio's local bridge (docs/studio.md): HTTP on 127.0.0.1 for the studio page on the site.
// It answers only the site's origin (and --origin ones) carrying the session's secret; it serves
// the project's runner for the page to frame, watches the project, renders and shares, all on
// this machine with the CLI's own hosts and commands. `handle` is the same routes without HTTP,
// for the relay's fallback (relay.ts).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  type FSWatcher,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frameTimes, type Json, type Manifest } from '@shaderera/core'
import { withVariant } from '@shaderera/core/host'
import { childOptions, DRAFT_HEIGHT, draftSize, insideFilm, open } from '../cli/args.ts'
import { defaultWorkers, exportVideo } from '../cli/render.ts'
import { LoginNeeded, shareProject, titleOf } from '../cli/share.ts'
import { DEFAULT_API } from '../cli/site.ts'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { RUNNER_PATH } from '../node/runner-plugin.ts'
import { HOST, startRunner } from '../node/runner-server.ts'
import { EDIT_FILES, type Entry, record, tail } from '../project/activity.ts'
import { checkBakes, checkJobBakes, pinBakes } from '../project/bakes.ts'
import {
  addComment,
  type CommentState,
  commentsFile,
  fold,
  listening,
  listing,
  type NewComment,
  parseOps,
  readThreads,
  replyTo,
  setState,
  type Thread,
} from '../project/comments.ts'
import { manifestAt, openRevision, windowOf } from '../project/jobs.ts'
import { outputRequirements, type Requirements, readRequirements } from '../project/requirements.ts'
import {
  changedFiles,
  type Files,
  hashFile,
  head,
  isSecret,
  materialize,
  prunedIds,
  type Revision,
  readRevision,
  releaseFrozen,
  log as revisionLog,
  save,
  scan,
  slash,
  store,
  treeId,
  validPath,
} from '../project/revisions.ts'
import { toPng } from '../review/review.ts'
import { keepNewestExport } from './exports.ts'
import { telemetryStatus } from './telemetry.ts'

/** An activity entry as the page gets it: `image` is true when `/activity/<id>/image` has one. */
export type ShownEntry = Omit<Entry, 'image'> & { image?: true }

export type StudioEvent =
  | {
      type: 'changed'
      revision: string
      files: { added: string[]; removed: string[]; changed: string[] }
    }
  | { type: 'activity'; entry: ShownEntry }
  | { type: 'comment'; comment: Thread & { stale: boolean } }
  | { type: 'agent'; listening: boolean }
  | {
      type: 'job'
      id: string
      state: 'queued' | 'running' | 'done' | 'failed'
      progress: number
      error?: string
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'share'; film: string; version: string; url: string }

/** A request to the bridge without HTTP: the method, the path (with its query) and a JSON body. */
export type BridgeRequest = { method: string; path: string; body?: unknown }
/** A route's answer: JSON, a file to stream, or a redirect (the runner). */
export type BridgeReply =
  | { status: number; json: unknown }
  | { status: 200; file: { path: string; type: string; name: string } }
  | { status: 302; location: string }

export type Format = 'mp4' | 'mov' | 'png'
/** A video render's window (seconds) and draft height, as `render --from --to --draft` take them. */
type Window = { from?: number; to?: number; draft?: number }
const TYPES: Record<Format, string> = { mp4: 'video/mp4', mov: 'video/quicktime', png: 'image/png' }

type Job = {
  id: string
  state: 'queued' | 'running' | 'done' | 'failed'
  progress: number
  error?: string
  format: Format
  file: string
}

export type Bridge = {
  port: number
  secret: string
  /** The bridge's own origin: `http://127.0.0.1:<port>`. */
  origin: string
  handle: (request: BridgeRequest) => Promise<BridgeReply>
  /** Every event the bridge sends on /events; returns a function that stops listening. */
  onEvent: (listener: (event: StudioEvent) => void) => () => void
  /**
   * Every request of the page's: one that passed the origin and secret checks, or came through
   * the relay (`handle`). Returns a function that stops listening.
   */
  onVisit: (listener: () => void) => () => void
  close: () => Promise<void>
}

const json = (status: number, value: unknown): BridgeReply => ({ status, json: value })

/** How many runners on revisions' frozen copies are open at once, besides the working tree's. */
export const FROZEN_RUNNERS = 2

/** An entry as the page gets it: its image's path is the bridge's business. */
const shown = (e: Entry): ShownEntry => {
  const { image, ...rest } = e
  return image ? { ...rest, image: true } : rest
}

/** The types of the files a film plays (`GET /file`); any other is `application/octet-stream`. */
const FILE_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/**
 * A file of the working tree a revision may hold, for `GET /file`: a path `save` would keep, not
 * through a link, and not a file that holds secrets.
 */
const projectFile = (root: string, path: string | null): BridgeReply => {
  if (!path || !validPath(path))
    return json(400, { error: 'path is a file of the project, as a revision names it' })
  let at = root
  let named = realpathSync.native(root)
  for (const part of path.split('/')) {
    at = join(at, part)
    named = join(named, part)
    try {
      if (lstatSync(at).isSymbolicLink()) return json(400, { error: `${path} goes through a link` })
    } catch {
      return json(404, { error: `${path} is not in the project` })
    }
    // Each part as the disk names it: another case (`.ENV` for `.env` on NTFS and APFS), an 8.3
    // short name (`ENV~1`) or any other alias is refused, so no rule above is passed by a spelling.
    if (realpathSync.native(at) !== named)
      return json(400, { error: `${path} is not the name the project gives that file` })
  }
  if (isSecret(at, basename(at))) return json(400, { error: `${path} holds secrets` })
  if (!statSync(at).isFile()) return json(404, { error: `${path} is not a file` })
  const type = FILE_TYPES[extname(at).toLowerCase()] ?? 'application/octet-stream'
  return { status: 200, file: { path: at, type, name: basename(at) } }
}

const REVISION = /^[0-9a-f]{16}$/
/** The 404 that says why a revision is not kept (unknown, or pruned); none when it is. */
const missing = (root: string, id: string): BridgeReply | undefined => {
  try {
    readRevision(root, id)
    return undefined
  } catch (error) {
    return json(404, { error: (error as Error).message })
  }
}

/** The stored revisions, oldest first, without their files; `unlisted` when no log line names it. */
const revisionsOf = (root: string) => {
  const listed = new Set(revisionLog(root).map((e) => e.id))
  const dir = join(root, 'versions', 'revisions')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {}
  return names
    .flatMap((name) => {
      try {
        const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Revision
        return [
          {
            id: r.id,
            parent: r.parent,
            created: r.created,
            by: r.by,
            ...(r.label ? { label: r.label } : {}),
            ...(r.note ? { note: r.note } : {}),
            ...(listed.has(r.id) ? {} : { unlisted: true }),
          },
        ]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.created.localeCompare(b.created))
}

/** Each variant's output as a host opens it: its size, length and rate, with the film's filled in. */
const sizesOf = (manifest: Manifest) =>
  Object.fromEntries(
    Object.keys(manifest.variants ?? {}).map((name) => {
      const { width, height, duration, fps } = withVariant(manifest, name).manifest
      return [name, { width, height, duration, fps }]
    }),
  )

/**
 * Each output's safe area, as `still --sheet` draws it: `main` and each variant → its margins, an
 * output with none left out. requirements.json unread: none, so /info still answers.
 */
const safeAreasOf = (root: string, manifest: Manifest) => {
  let req: Requirements
  try {
    req = readRequirements(root)
  } catch {
    return {}
  }
  return Object.fromEntries(
    ['main', ...Object.keys(manifest.variants ?? {})].flatMap((name) => {
      const { safeArea } = outputRequirements(req, {
        ...(name === 'main' ? {} : { variant: name }),
        ...manifest,
      })
      return safeArea ? [[name, safeArea]] : []
    }),
  )
}

/**
 * `Content-Disposition` for a file to save: the name in ASCII (anything else, `"` and `\` as
 * `_`), and the name itself in UTF-8 (RFC 6266), so a project named in any script is a header
 * Node sends.
 */
const attachment = (name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const utf8 = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16)}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

/** The answer to a body over 1 MB: the connection closes after it. */
const TOO_BIG = 'The request body is over 1 MB.'

/**
 * Reads a request body as JSON (at most 1 MB); none is undefined. A larger one is read to its end
 * and dropped, so its connection is never cut mid-request.
 */
const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of req) {
    size += (part as Buffer).length
    if (size <= 1 << 20) parts.push(part as Buffer)
  }
  if (size > 1 << 20) throw new Error(TOO_BIG)
  const text = Buffer.concat(parts).toString('utf8').trim()
  return text ? JSON.parse(text) : undefined
}

const sameSecret = (given: string | null | undefined, secret: string): boolean =>
  typeof given === 'string' &&
  given.length === secret.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(secret))

/**
 * Starts the bridge for the project at `root`: the runner server under a secret base, the
 * watcher, and the HTTP server on 127.0.0.1 on a free port. `origins` are the pages it answers
 * (the site's first); `hostFlags` are the render's `--host`, `--trusted` and `--timeout`.
 */
export const startBridge = async (o: {
  root: string
  /** Where Share sends films: `shaderera studio --api`, as `shaderera share --api`. */
  api: string
  /** The site whose pages show a shared film: `--site`, as `shaderera share --site`. */
  site: string
  origins: readonly string[]
  hostFlags?: { host?: unknown; trusted?: unknown; timeout?: unknown }
  /** Debounce for the watcher, in ms. */
  settleMs?: number
  /** `POST /stop` from the CLI (`studio --stop`): the command should end. Without it, no route. */
  onStop?: () => void
  /** The token `POST /stop` carries: not the secret, and good for nothing else. */
  stopToken?: string
  /** How long a revision's runner whose frame was just sent is kept past the cap, in ms. */
  runnerKeepMs?: number
  /** For tests: false leaves the comments and the activity to the poll alone. */
  tailOnWatch?: boolean
}): Promise<Bridge> => {
  const project = await findProject(o.root)
  const { root } = project
  const secret = randomBytes(16).toString('hex')
  const listeners = new Set<(event: StudioEvent) => void>()
  const emit = (event: StudioEvent) => {
    for (const l of listeners) l(event)
  }
  const log = (level: 'info' | 'warn' | 'error', text: string) => emit({ type: 'log', level, text })
  const visitors = new Set<() => void>()
  const visit = () => {
    for (const l of visitors) l()
  }

  // The runner, for the page to frame: the project's own Vite under a base no one else knows.
  const base = `/runner/${randomBytes(16).toString('hex')}/`
  let bakes: ReturnType<typeof checkBakes> | undefined
  try {
    bakes = checkBakes(root, project.manifest)
  } catch (error) {
    // A stale bake fails io.bake in the preview, not the studio.
    log('warn', (error as Error).message)
  }
  const runner = await startRunner(project, {
    pkgDir: fileURLToPath(new URL('../..', import.meta.url)),
    studioOrigins: o.origins,
    cacheDir: join(root, '.shaderera', 'studio-vite'),
    base,
    ...(bakes ? { bakes } : {}),
    log,
  })
  const runnerPage = `http://${HOST}:${runner.port}${base}${RUNNER_PATH.slice(1)}`

  // The watcher: `changed` once the files settle, when the revision differs. Only the files a
  // revision holds count; each is hashed again only when its size or time changed.
  const hashes = new Map<string, { size: number; mtime: number; sha: string }>()
  const hashCached = (file: string) => {
    const s = statSync(file)
    const known = hashes.get(file)
    if (known && known.size === s.size && known.mtime === s.mtimeMs) return known.sha
    const sha = hashFile(file)
    hashes.set(file, { size: s.size, mtime: s.mtimeMs, sha })
    return sha
  }
  const filesNow = () => scan(root, undefined, undefined, hashCached)
  let files: Files = filesNow()
  let revision = treeId(files)
  let settle: NodeJS.Timeout | undefined
  const scanSoon = () => {
    clearTimeout(settle)
    settle = setTimeout(() => {
      try {
        const now = filesNow()
        const id = treeId(now)
        if (id === revision) return
        const changed = changedFiles(files, now)
        files = now
        revision = id
        emit({ type: 'changed', revision, files: changed })
        // The edit, for the activity (the tail sends it on).
        const cap = (names: string[]) => names.slice(0, EDIT_FILES)
        record(root, {
          by: 'studio',
          kind: 'edit',
          revision,
          files: {
            added: cap(changed.added),
            removed: cap(changed.removed),
            changed: cap(changed.changed),
          },
        })
        tailActivity()
      } catch (error) {
        // A file removed mid-scan: the next event scans again.
        log('warn', `watch: ${(error as Error).message}`)
      }
    }, o.settleMs ?? 150)
  }

  // The files other processes write while the studio runs (decision 0025): the comments and the
  // activity, sent on as they grow. The CLI and MCP need no channel to the bridge.
  // The activity by id, not by time: two processes may append their lines out of their ids'
  // order. All of it is read (two files of at most 1 MB), so a burst is never cut short.
  let seenEntries = new Set(tail(root, Number.MAX_SAFE_INTEGER).map((e) => e.id))
  const tailActivity = () => {
    const now = tail(root, Number.MAX_SAFE_INTEGER)
    for (const e of now) if (!seenEntries.has(e.id)) emit({ type: 'activity', entry: shown(e) })
    seenEntries = new Set(now.map((e) => e.id))
  }
  // The comments by operation: the threads the new lines touch, folded with all the lines.
  const opsNow = () => {
    try {
      return parseOps(readFileSync(commentsFile(root), 'utf8'))
    } catch {
      return []
    }
  }
  let opsSeen = opsNow().length
  const tailComments = () => {
    const ops = opsNow()
    // Fewer lines than before: the file was replaced, and every thread is sent again.
    const fresh = ops.length >= opsSeen ? ops.slice(opsSeen) : ops
    opsSeen = ops.length
    if (fresh.length === 0) return
    const touched = new Set(fresh.map((op) => op.id))
    const tree = treeId(filesNow())
    for (const t of fold(ops))
      if (touched.has(t.id))
        emit({ type: 'comment', comment: { ...t, stale: t.revision !== tree } })
  }
  const sizeOf = (file: string) => {
    try {
      const s = statSync(file)
      return `${s.size}:${s.mtimeMs}`
    } catch {
      return ''
    }
  }
  const activityFile = join(root, '.shaderera', 'activity.jsonl')
  const sizes = { activity: sizeOf(activityFile), comments: sizeOf(commentsFile(root)) }
  /** Each file on its own: one that fails is read again next time, and never holds up the other. */
  const tails = () => {
    for (const [which, file, read] of [
      ['activity', activityFile, tailActivity],
      ['comments', commentsFile(root), tailComments],
    ] as const) {
      const now = sizeOf(file)
      if (now === sizes[which]) continue
      try {
        read()
        sizes[which] = now
      } catch (error) {
        log('warn', `watch: ${(error as Error).message}`)
      }
    }
  }
  // One watcher: the comments and the activity before the filter that keeps to a revision's files.
  const watcher: FSWatcher = watch(root, { recursive: true }, (_, name) => {
    const path = name ? slash(String(name)) : ''
    if (path === 'versions/comments.jsonl' || path.startsWith('.shaderera/activity')) {
      if (o.tailOnWatch !== false) tails()
      return
    }
    if (name && !validPath(path)) return
    scanSoon()
  })

  // Runners on revisions' frozen copies (/runner?revision=), for compare: at most FROZEN_RUNNERS
  // besides the working tree's, the least recently used closed first, but never one whose frame
  // was sent in the last `runnerKeepMs` (it is still loading in the page). Each has a Vite cache
  // of its own, reused only once the runner that had it has closed.
  type Frozen = { page: string; slot: number; close: () => Promise<void> }
  const frozen = new Map<string, Promise<Frozen>>()
  const sentAt = new Map<string, number>()
  const slots = new Set<number>()
  const closing = new Set<Promise<void>>()
  const keepMs = o.runnerKeepMs ?? 30_000
  const trimRunners = () => {
    for (const [id, f] of frozen) {
      if (frozen.size <= FROZEN_RUNNERS) return
      if (Date.now() - (sentAt.get(id) ?? 0) < keepMs) continue
      frozen.delete(id)
      sentAt.delete(id)
      const done = f.then((x) => x.close().finally(() => slots.delete(x.slot))).catch(() => {})
      closing.add(done)
      void done.finally(() => closing.delete(done))
    }
  }
  const frozenRunner = (id: string) => {
    sentAt.set(id, Date.now())
    const known = frozen.get(id)
    if (known) {
      frozen.delete(id)
      frozen.set(id, known)
      return known
    }
    const opening = (async (): Promise<Frozen> => {
      // After the trim below: the runners it closes free their caches first.
      await Promise.resolve()
      await Promise.all([...closing])
      const revision = readRevision(root, id)
      const dir = materialize(root, id)
      let slot: number | undefined
      try {
        const declared = manifestAt(root, id)
        let pinned: ReturnType<typeof checkJobBakes> | undefined
        try {
          pinned = checkJobBakes({
            name: `revision ${id}`,
            revision: id,
            inputs: { bakes: pinBakes(root, declared, id, revision.files) },
          })
        } catch (error) {
          log('warn', (error as Error).message)
        }
        slot = 0
        while (slots.has(slot)) slot++
        slots.add(slot)
        const secretBase = `/runner/${randomBytes(16).toString('hex')}/`
        const server = await startRunner(
          { root: dir, manifest: declared },
          {
            pkgDir: fileURLToPath(new URL('../..', import.meta.url)),
            studioOrigins: o.origins,
            cacheDir: join(root, '.shaderera', `studio-vite-${slot + 1}`),
            base: secretBase,
            allow: [root],
            ...(pinned ? { bakes: pinned } : {}),
            log,
          },
        )
        return {
          page: `http://${HOST}:${server.port}${secretBase}${RUNNER_PATH.slice(1)}`,
          slot,
          close: async () => {
            await server.server.close()
            releaseFrozen(root, id)
          },
        }
      } catch (error) {
        if (slot !== undefined) slots.delete(slot)
        releaseFrozen(root, id)
        throw error
      }
    })()
    frozen.set(id, opening)
    opening.catch(() => {
      if (frozen.get(id) === opening) frozen.delete(id)
    })
    trimRunners()
    return opening
  }

  // Every second: what a watch missed, the runners past the cap whose frames have loaded, and
  // whether an agent waits for comments (its waiter's file is touched every second, so a stale
  // one means it stopped).
  let waiting = listening(root)
  const poll = setInterval(() => {
    tails()
    trimRunners()
    const now = listening(root)
    if (now === waiting) return
    waiting = now
    emit({ type: 'agent', listening: now })
  }, 1000)
  poll.unref()

  // Renders, one at a time, in the order asked; closing the bridge stops the one running.
  const jobs = new Map<string, Job>()
  const stop = new AbortController()
  /** The cancel of each job queued or running (POST /render/<id>/cancel). */
  const cancels = new Map<string, AbortController>()
  let queue: Promise<void> = Promise.resolve()
  const report = (job: Job) =>
    emit({
      type: 'job',
      id: job.id,
      state: job.state,
      progress: job.progress,
      ...(job.error ? { error: job.error } : {}),
    })
  const render = async (
    job: Job,
    r: { variant?: string; params: object; t: number; revision?: string } & Window,
    signal: AbortSignal,
  ) => {
    const flags = {
      ...o.hostFlags,
      root,
      ...(r.variant ? { variant: r.variant } : {}),
      ...(r.draft ? { draft: r.draft } : {}),
      param: Object.entries(r.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    }
    // A revision renders from its frozen copy, on one host; the tree, on as many as it takes.
    const {
      project: opened,
      child,
      more: opener,
      close,
    } = r.revision
      ? await openRevision(root, r.revision, {
          ...(r.variant ? { variant: r.variant } : {}),
          ...(r.draft
            ? {
                size: draftSize(
                  withVariant(manifestAt(root, r.revision), r.variant).manifest,
                  r.draft,
                ),
              }
            : {}),
          params: r.params as { [key: string]: Json },
          host: o.hostFlags?.host,
          ...childOptions(o.hostFlags ?? {}),
        }).then((x) => ({ ...x, more: undefined }))
      : { ...(await open(flags)), close: undefined }
    // A cancelled job's hosts are closed, every one: a frame that never settles ends with them.
    const hosts = [child]
    const more = async () => {
      if (!opener) throw new Error('A revision renders on one host.')
      const host = await opener()
      hosts.push(host)
      if (signal.aborted) void host.close()
      return host
    }
    const closeChild = () => {
      for (const host of hosts) void host.close()
    }
    signal.addEventListener('abort', closeChild, { once: true })
    try {
      signal.throwIfAborted()
      const traced = r.revision ?? save(root, { by: 'studio' }).id
      mkdirSync(join(root, 'out', 'studio'), { recursive: true })
      const { manifest } = opened
      if (job.format === 'png') {
        insideFilm([r.t], manifest.duration)
        const { pixels } = await child.render(r.t, 'final')
        writeFileSync(job.file, await toPng(pixels, manifest.width, manifest.height))
        return
      }
      let last = 0
      await exportVideo(opened, child, {
        codec: job.format === 'mov' ? 'prores-hq' : 'h264',
        out: job.file,
        workers: opener
          ? defaultWorkers(
              manifest,
              frameTimes(manifest.fps, r.from ?? 0, r.to ?? manifest.duration).length,
            )
          : 1,
        ...(r.from !== undefined ? { from: r.from } : {}),
        ...(r.to !== undefined ? { to: r.to } : {}),
        ...(opener ? { more } : {}),
        revision: traced,
        signal,
        onFrame: (i, n, phase) => {
          // The re-check after the last frame leaves the job at 1.
          if (phase) return
          job.progress = (i + 1) / n
          // About a hundred reports a render, not one a frame.
          if (job.progress - last >= 0.01 || i + 1 === n) {
            last = job.progress
            report(job)
          }
        },
      })
    } finally {
      signal.removeEventListener('abort', closeChild)
      // A revision's close also releases its frozen copy.
      await (close ? close() : child.close())
    }
  }

  /** A render's end, for the activity (the tail sends it on). */
  const rendered = (job: Job, variant?: string, revision?: string) => {
    record(root, {
      by: 'studio',
      kind: 'render',
      job: job.id,
      ok: job.state === 'done',
      format: job.format,
      ...(variant ? { variant } : {}),
      ...(revision ? { revision } : {}),
      ...(job.state === 'done' ? { file: slash(relative(root, job.file)) } : {}),
      ...(job.error ? { error: job.error } : {}),
    })
    tailActivity()
  }

  /** Queues one render job; its id. */
  const queueJob = (
    format: Format,
    variant: string | undefined,
    params: object,
    t: number,
    revision?: string,
    window: Window = {},
  ) => {
    const id = randomBytes(6).toString('hex')
    // A variant's name may hold what a file name cannot (`16:9`), as in project/jobs.ts; a window
    // adds its seconds and a draft says so, as render names them, so one never replaces another.
    const name = `${basename(root)}${variant ? `-${variant.replace(/[^\p{L}\p{M}\p{N}_.-]/gu, '_')}` : ''}${revision ? `-${revision}` : ''}${window.from !== undefined || window.to !== undefined ? `-${(window.from ?? 0).toFixed(1)}-${window.to === undefined ? 'end' : window.to.toFixed(1)}` : ''}${window.draft ? '-draft' : ''}-${id}.${format}`
    const job: Job = {
      id,
      state: 'queued',
      progress: 0,
      format,
      file: join(root, 'out', 'studio', name),
    }
    jobs.set(id, job)
    const cancel = new AbortController()
    cancels.set(id, cancel)
    report(job)
    queue = queue.then(async () => {
      // Cancelled while queued: failed already.
      if (cancel.signal.aborted) return
      job.state = 'running'
      report(job)
      const signal = AbortSignal.any([stop.signal, cancel.signal])
      try {
        // The queue goes on at a cancel, while the render winds down (its host closing).
        const rendering = render(
          job,
          {
            ...(variant ? { variant } : {}),
            params,
            t,
            ...(revision ? { revision } : {}),
            ...window,
          },
          signal,
        )
        rendering.catch(() => {})
        await Promise.race([
          rendering,
          new Promise((_, fail) =>
            signal.addEventListener('abort', () => fail(signal.reason), { once: true }),
          ),
        ])
        job.state = 'done'
        job.progress = 1
        keepNewestExport(job.file)
      } catch (error) {
        job.state = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        log('error', `render ${id}: ${job.error}`)
      } finally {
        cancels.delete(id)
      }
      report(job)
      rendered(job, variant, revision)
    })
    return id
  }

  const routes = async (r: BridgeRequest): Promise<BridgeReply> => {
    const url = new URL(r.path, 'http://bridge')
    const route = `${r.method} ${url.pathname}`
    if (route === 'GET /info') {
      const { manifest } = await findProject(root)
      return json(200, {
        version: shadereraVersion(),
        film: {
          title: titleOf(root),
          manifest,
          variants: manifest.variants ?? {},
          sizes: sizesOf(manifest),
          safeAreas: safeAreasOf(root, manifest),
          schema: manifest.params ?? null,
        },
        telemetry: telemetryStatus().on,
        revision: treeId(filesNow()),
        head: head(root),
        listening: listening(root),
        // Only another films API than the default, for the page's command to run this again.
        ...(o.api !== DEFAULT_API ? { api: o.api } : {}),
      })
    }
    if (route === 'GET /runner') {
      const variant = url.searchParams.get('variant')
      const id = url.searchParams.get('revision')
      if (id !== null && !REVISION.test(id))
        return json(400, { error: 'revision is a revision id, 16 hex digits' })
      let page = runnerPage
      let variants = (await findProject(root)).manifest.variants ?? {}
      if (id !== null) {
        const found = missing(root, id)
        if (found) return found
        variants = manifestAt(root, id).variants ?? {}
        page = (await frozenRunner(id)).page
      } else
        try {
          // The tree the page frames is stored, unlisted, so a comment on it names a tree that
          // exists however the files change while the person writes (decision 0025, point 5).
          store(root, { by: 'studio' })
        } catch (error) {
          log('warn', `the framed tree was not stored: ${(error as Error).message}`)
        }
      if (variant !== null && !Object.hasOwn(variants, variant))
        return json(400, { error: `shaderera.json has no variant "${variant}"` })
      const query = new URLSearchParams(url.search)
      query.delete('s')
      const rest = query.toString()
      return { status: 302, location: `${page}${rest ? `?${rest}` : ''}` }
    }
    if (route === 'GET /comments') {
      try {
        const state = (url.searchParams.get('state') ?? 'all') as CommentState | 'all'
        return json(200, listing(root, { state }).comments)
      } catch (error) {
        return json(400, { error: (error as Error).message })
      }
    }
    if (route === 'POST /comments') {
      // The page's comments are the person's: only the bridge writes `person` (decision 0025).
      const body = (r.body ?? {}) as NewComment
      // The tree the page shows, which the comment points at (decision 0025, point 3).
      if (typeof body.revision !== 'string')
        return json(400, { error: 'revision is the revision id of the tree the page shows' })
      try {
        return json(200, await addComment(root, body, 'person'))
      } catch (error) {
        return json(400, { error: (error as Error).message })
      }
    }
    const thread = /^POST \/comments\/([^/]+)\/(reply|state)$/.exec(route)
    if (thread) {
      const [, id, op] = thread as unknown as [string, string, 'reply' | 'state']
      const body = (r.body ?? {}) as { text?: unknown; state?: unknown }
      if (!readThreads(root).some((t) => t.id === id))
        return json(404, { error: `no comment ${id}` })
      try {
        if (op === 'reply')
          return json(200, await replyTo(root, id, body.text as string, { by: 'person' }))
        if (body.state !== 'open' && body.state !== 'resolved' && body.state !== 'deleted')
          return json(400, { error: 'state is open, resolved or deleted' })
        return json(200, await setState(root, id, body.state, 'person'))
      } catch (error) {
        return json(400, { error: (error as Error).message })
      }
    }
    if (route === 'GET /activity') {
      const limit = Number(url.searchParams.get('limit') ?? 200)
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        return json(400, { error: 'limit is a whole number from 1 to 1000' })
      return json(200, tail(root, limit).map(shown))
    }
    const image = /^GET \/activity\/([^/]+)\/image$/.exec(route)
    if (image) {
      const id = image[1] as string
      const file = join(root, '.shaderera', 'activity', `${id}.png`)
      if (!/^[0-9a-z]+-[0-9a-f]{8}$/.test(id) || !existsSync(file))
        return json(404, { error: `no image for entry ${id}` })
      return { status: 200, file: { path: file, type: 'image/png', name: `${id}.png` } }
    }
    if (route === 'GET /versions') {
      const pruned = prunedIds(root)
      const gone = (id: string) =>
        pruned.has(id) && !existsSync(join(root, 'versions', 'revisions', `${id}.json`))
      return json(200, {
        head: head(root),
        log: revisionLog(root).map((e) => (gone(e.id) ? { ...e, pruned: true } : e)),
        revisions: revisionsOf(root),
      })
    }
    if (route === 'GET /file') return projectFile(root, url.searchParams.get('path'))
    if (route === 'POST /render') {
      const body = (r.body ?? {}) as {
        variant?: unknown
        variants?: unknown
        params?: unknown
        format?: unknown
        t?: unknown
        revision?: unknown
        from?: unknown
        to?: unknown
        draft?: unknown
      }
      // Every field is checked before a job is queued: a bad one opens no host, saves nothing.
      const format = body.format as Format
      if (typeof format !== 'string' || !Object.hasOwn(TYPES, format))
        return json(400, { error: 'format is mp4, mov or png' })
      if (body.variant !== undefined && typeof body.variant !== 'string')
        return json(400, { error: 'variant is a name' })
      const many = body.variants
      if (
        many !== undefined &&
        (!Array.isArray(many) ||
          many.length === 0 ||
          !many.every((v) => typeof v === 'string') ||
          body.variant !== undefined)
      )
        return json(400, { error: 'variants is a list of names, without variant' })
      if (
        body.params !== undefined &&
        (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))
      )
        return json(400, { error: 'params is an object' })
      if (body.t !== undefined && (typeof body.t !== 'number' || !Number.isFinite(body.t)))
        return json(400, { error: 't is a time in seconds' })
      const params = (body.params ?? {}) as object
      const t = (body.t as number | undefined) ?? 0
      const revision = body.revision
      if (revision !== undefined && (typeof revision !== 'string' || !REVISION.test(revision)))
        return json(400, { error: 'revision is a revision id, 16 hex digits' })
      if (revision !== undefined) {
        const gone = missing(root, revision)
        if (gone) return gone
      }
      // A revision's own variants and length: the ones it renders with.
      const manifest =
        revision === undefined ? (await findProject(root)).manifest : manifestAt(root, revision)
      const names: (string | undefined)[] =
        many === undefined ? [body.variant as string | undefined] : [...new Set(many as string[])]
      const unknown = names.find(
        (v) => v !== undefined && !Object.hasOwn(manifest.variants ?? {}, v),
      )
      if (unknown !== undefined)
        return json(400, { error: `shaderera.json has no variant "${unknown}"` })
      if (format === 'png')
        for (const v of names) {
          const { duration } = v === undefined ? manifest : withVariant(manifest, v).manifest
          if (t < 0 || t >= duration)
            return json(400, {
              error: `t ${t} is outside the film${v === undefined ? '' : ` "${v}"`} (0 to ${duration} s)`,
            })
        }
      // A window and a draft, a video's only: checked as render checks --from, --to and --draft.
      const draft = body.draft === true ? DRAFT_HEIGHT : body.draft
      if (
        draft !== undefined &&
        (typeof draft !== 'number' || !Number.isInteger(draft) || draft < 2)
      )
        return json(400, { error: 'draft is true or a height in pixels, such as 360' })
      const window: Window = {
        ...(body.from !== undefined ? { from: body.from as number } : {}),
        ...(body.to !== undefined ? { to: body.to as number } : {}),
        ...(draft !== undefined ? { draft: draft as number } : {}),
      }
      if (Object.keys(window).length > 0 && format === 'png')
        return json(400, { error: 'from, to and draft are for a video (mp4 or mov)' })
      for (const v of names)
        try {
          windowOf(
            v === undefined ? manifest : withVariant(manifest, v).manifest,
            window.from,
            window.to,
          )
        } catch (error) {
          return json(400, { error: (error as Error).message })
        }
      const queued = names.map((v) => queueJob(format, v, params, t, revision, window))
      return json(200, many === undefined ? { job: queued[0] } : { jobs: queued })
    }
    const cancel = /^POST \/render\/([0-9a-f]+)\/cancel$/.exec(route)
    if (cancel) {
      const job = jobs.get(cancel[1] as string)
      if (!job) return json(404, { error: 'no such job' })
      const c = cancels.get(job.id)
      if (!c) return json(409, { error: `the job is ${job.state}` })
      c.abort(new Error('cancelled'))
      // A queued job never runs; a running one fails at once (the queue's race), its host closing.
      if (job.state === 'queued') {
        cancels.delete(job.id)
        job.state = 'failed'
        job.error = 'cancelled'
        report(job)
        rendered(job)
      }
      return json(200, { job: job.id })
    }
    const file = /^GET \/render\/([0-9a-f]+)\/file$/.exec(route)
    if (file) {
      const job = jobs.get(file[1] as string)
      if (!job) return json(404, { error: 'no such job' })
      if (job.state !== 'done') return json(409, { error: `the job is ${job.state}` })
      if (!existsSync(job.file))
        return json(404, { error: `${slash(relative(root, job.file))} is no longer there` })
      return {
        status: 200,
        file: { path: job.file, type: TYPES[job.format], name: basename(job.file) },
      }
    }
    if (route === 'POST /share') {
      const body = (r.body ?? {}) as { title?: unknown }
      try {
        const shared = await shareProject({
          root,
          api: o.api,
          site: o.site,
          ...(o.hostFlags ? { hostFlags: o.hostFlags } : {}),
          ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
          // Its steps are not the page's log: the share's end is in the activity.
          say: () => {},
          warn: (line) => log('warn', line),
        })
        if (!shared) throw new Error('Nothing was sent.')
        const { film, version, url } = shared
        emit({ type: 'share', film, version, url })
        record(root, { by: 'studio', kind: 'share', ok: true, film, version, url })
        tailActivity()
        return json(200, { film, version, url })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof LoginNeeded || / 401 /.test(message))
          return json(401, { error: 'login', command: 'npx shaderera login' })
        log('error', `share: ${message}`)
        record(root, { by: 'studio', kind: 'share', ok: false, error: message })
        tailActivity()
        return json(500, { error: message })
      }
    }
    return json(404, { error: `no route ${route}` })
  }
  const handle = async (r: BridgeRequest): Promise<BridgeReply> => {
    visit()
    try {
      return await routes(r)
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const sse = new Set<ServerResponse>()
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin
    const url = new URL(req.url ?? '/', 'http://bridge')
    const allowed = origin !== undefined && o.origins.includes(origin)
    const cors: Record<string, string> = allowed
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { Vary: 'Origin' }
    const refuse = (status: number, error: string) => {
      res.writeHead(status, {
        ...cors,
        'Content-Type': 'application/json',
        ...(error === TOO_BIG ? { Connection: 'close' } : {}),
      })
      res.end(JSON.stringify({ error }))
    }
    if (req.method === 'OPTIONS') {
      if (!allowed) return refuse(403, 'origin')
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      })
      return res.end()
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    // The CLI's own request (`studio --stop`): no Origin, the secret, on 127.0.0.1 as every
    // request here. Never through the relay: a page cannot send one.
    if (
      origin === undefined &&
      req.method === 'POST' &&
      url.pathname === '/stop' &&
      o.onStop &&
      o.stopToken
    ) {
      if (!sameSecret(bearer, o.stopToken)) return refuse(403, 'secret')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ stopping: true }))
      o.onStop()
      return
    }
    // A frame's navigation to /runner carries no Origin: its secret is in the query, and the
    // runner page itself may be framed only by the allowed origins.
    const framing = origin === undefined && req.method === 'GET' && url.pathname === '/runner'
    if (!allowed && !framing) return refuse(403, 'origin')
    if (!sameSecret(bearer ?? url.searchParams.get('s'), secret)) return refuse(403, 'secret')

    if (req.method === 'GET' && url.pathname === '/events') {
      visit()
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': shaderera studio\n\n')
      sse.add(res)
      req.on('close', () => sse.delete(res))
      return
    }
    let body: unknown
    try {
      body = req.method === 'POST' ? await readBody(req) : undefined
    } catch (error) {
      return refuse(400, (error as Error).message)
    }
    const reply = await handle({ method: req.method ?? 'GET', path: req.url ?? '/', body })
    if ('location' in reply) {
      res.writeHead(302, { ...cors, Location: reply.location })
      return res.end()
    }
    if ('file' in reply) {
      res.writeHead(200, {
        ...cors,
        'Content-Type': reply.file.type,
        'Content-Length': String(statSync(reply.file.path).size),
        'Content-Disposition': attachment(reply.file.name),
        'Access-Control-Expose-Headers': 'Content-Disposition',
      })
      createReadStream(reply.file.path)
        .on('error', () => res.destroy())
        .pipe(res)
      return
    }
    res.writeHead(reply.status, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.json))
  }
  // A request that fails is a 500 for it, never the end of the command.
  const server = createServer((req, res) => {
    serve(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  listeners.add((event) => {
    for (const res of sse) res.write(`data: ${JSON.stringify(event)}\n\n`)
  })
  // A comment now and then keeps proxies and the page's EventSource from timing out.
  const heartbeat = setInterval(() => {
    for (const res of sse) res.write(': ping\n\n')
  }, 15_000)
  heartbeat.unref()
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, HOST, () => done())
  })
  const port = (server.address() as AddressInfo).port

  return {
    port,
    secret,
    origin: `http://${HOST}:${port}`,
    handle,
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onVisit: (listener) => {
      visitors.add(listener)
      return () => visitors.delete(listener)
    },
    close: async () => {
      clearInterval(heartbeat)
      clearInterval(poll)
      clearTimeout(settle)
      watcher.close()
      stop.abort(new Error('The studio closed.'))
      for (const res of sse) res.end()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      await queue
      await runner.server.close()
      await Promise.all([
        ...[...frozen.values()].map((f) => f.then((x) => x.close()).catch(() => {})),
        ...closing,
      ])
    },
  }
}
