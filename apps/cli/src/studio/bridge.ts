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
  mkdirSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frameTimes, type Manifest } from '@shaderera/core'
import { withVariant } from '@shaderera/core/host'
import { insideFilm, open } from '../cli/args.ts'
import { defaultWorkers, exportVideo } from '../cli/render.ts'
import { LoginNeeded, shareProject, titleOf } from '../cli/share.ts'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { RUNNER_PATH } from '../node/runner-plugin.ts'
import { HOST, startRunner } from '../node/runner-server.ts'
import { checkBakes } from '../project/bakes.ts'
import { hashFile, save, scan, slash, treeId, validPath } from '../project/revisions.ts'
import { toPng } from '../review/review.ts'
import { keepNewestExport } from './exports.ts'
import { telemetryStatus } from './telemetry.ts'

export type StudioEvent =
  | { type: 'changed'; revision: string }
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

/** Each variant's output as a host opens it: its size, length and rate, with the film's filled in. */
const sizesOf = (manifest: Manifest) =>
  Object.fromEntries(
    Object.keys(manifest.variants ?? {}).map((name) => {
      const { width, height, duration, fps } = withVariant(manifest, name).manifest
      return [name, { width, height, duration, fps }]
    }),
  )

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
  const revisionNow = () => treeId(scan(root, undefined, undefined, hashCached))
  let revision = revisionNow()
  let settle: NodeJS.Timeout | undefined
  const watcher: FSWatcher = watch(root, { recursive: true }, (_, name) => {
    if (name && !validPath(slash(String(name)))) return
    clearTimeout(settle)
    settle = setTimeout(() => {
      try {
        const now = revisionNow()
        if (now !== revision) {
          revision = now
          emit({ type: 'changed', revision })
        }
      } catch (error) {
        // A file removed mid-scan: the next event scans again.
        log('warn', `watch: ${(error as Error).message}`)
      }
    }, o.settleMs ?? 150)
  })

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
    r: { variant?: string; params: object; t: number },
    signal: AbortSignal,
  ) => {
    const flags = {
      ...o.hostFlags,
      root,
      ...(r.variant ? { variant: r.variant } : {}),
      param: Object.entries(r.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    }
    const { project: opened, child, more: opener } = await open(flags)
    // A cancelled job's hosts are closed, every one: a frame that never settles ends with them.
    const hosts = [child]
    const more = async () => {
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
      const traced = save(root, { by: 'studio' }).id
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
        workers: defaultWorkers(manifest, frameTimes(manifest.fps, 0, manifest.duration).length),
        more,
        revision: traced,
        signal,
        onFrame: (i, n) => {
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
      await child.close()
    }
  }

  /** Queues one render job; its id. */
  const queueJob = (format: Format, variant: string | undefined, params: object, t: number) => {
    const id = randomBytes(6).toString('hex')
    // A variant's name may hold what a file name cannot (`16:9`), as in project/jobs.ts.
    const name = `${basename(root)}${variant ? `-${variant.replace(/[^\p{L}\p{M}\p{N}_.-]/gu, '_')}` : ''}-${id}.${format}`
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
      log('info', `render ${id}: ${format}${variant ? ` of ${variant}` : ''}`)
      const signal = AbortSignal.any([stop.signal, cancel.signal])
      try {
        // The queue goes on at a cancel, while the render winds down (its host closing).
        const rendering = render(job, { ...(variant ? { variant } : {}), params, t }, signal)
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
        log('info', `render ${id}: ${slash(relative(root, job.file))}`)
      } catch (error) {
        job.state = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        log('error', `render ${id}: ${job.error}`)
      } finally {
        cancels.delete(id)
      }
      report(job)
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
          schema: manifest.params ?? null,
        },
        telemetry: telemetryStatus().on,
      })
    }
    if (route === 'GET /runner') {
      const variant = url.searchParams.get('variant')
      if (
        variant !== null &&
        !Object.hasOwn((await findProject(root)).manifest.variants ?? {}, variant)
      )
        return json(400, { error: `shaderera.json has no variant "${variant}"` })
      const query = new URLSearchParams(url.search)
      query.delete('s')
      const rest = query.toString()
      return { status: 302, location: `${runnerPage}${rest ? `?${rest}` : ''}` }
    }
    if (route === 'POST /render') {
      const body = (r.body ?? {}) as {
        variant?: unknown
        variants?: unknown
        params?: unknown
        format?: unknown
        t?: unknown
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
      const { manifest } = await findProject(root)
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
      const queued = names.map((v) => queueJob(format, v, params, t))
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
        log('info', `render ${job.id}: cancelled`)
        report(job)
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
          say: (line) => log('info', line),
          warn: (line) => log('warn', line),
        })
        if (!shared) throw new Error('Nothing was sent.')
        log('info', `shared ${shared.url}`)
        emit({ type: 'share', film: shared.film, version: shared.version, url: shared.url })
        return json(200, { film: shared.film, version: shared.version, url: shared.url })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof LoginNeeded || / 401 /.test(message))
          return json(401, { error: 'login', command: 'npx shaderera login' })
        log('error', `share: ${message}`)
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
    if (origin === undefined && req.method === 'POST' && url.pathname === '/stop' && o.onStop) {
      if (!sameSecret(bearer, secret)) return refuse(403, 'secret')
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
      clearTimeout(settle)
      watcher.close()
      stop.abort(new Error('The studio closed.'))
      for (const res of sse) res.end()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      await queue
      await runner.server.close()
    },
  }
}
