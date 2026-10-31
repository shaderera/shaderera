// The child is an execution boundary, NOT a secure sandbox for hostile code: Node 24's
// permission model blocks file writes and child processes, but it does not cover the network and
// native addons are allowed (the canvas is one). Run code you would run with `node` anyway.
import { type ChildProcess, fork } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Caption, Json, Matrices, Pick, Range, SampledClip } from '@shaderera/core'
import type { GpuOutput, HdrOutput, LightLevels, SeekStats } from '@shaderera/core/host'
import { paramDefaults } from '@shaderera/core/host'
import type { TextRun } from '../review/measure.ts'
import { hostOfBuild } from './build.ts'
import { BULK_FD, bulkReader, isBulk } from './bulk.ts'
import type { Fonts, HostProfile, Request } from './host.ts'
import { outside } from './inside.ts'
import { readJson } from './json.ts'
import type { Project } from './project.ts'
import { type BakeFrames, createServices, type ServiceRequest } from './services.ts'

const modules = `${sep}node_modules${sep}`
/** How much of a host's stderr is kept, and how many of its last lines an exit's error names. */
const STDERR_KEPT = 4000
const STDERR_LINES = 12

/**
 * The `--permission` flags for a child that reads `root` and the given package directories (real
 * paths). A package inside a `node_modules` folder widens to that whole folder, so its own
 * dependencies resolve in any layout: a pnpm store, or npm's flat one where a native addon's
 * platform package sits beside it. One already under another allowed directory adds nothing.
 */
export const permissionArgs = (root: string, packages: readonly string[]): string[] => {
  const dirs = [
    root,
    ...packages.map((p) =>
      p.includes(modules) ? p.slice(0, p.indexOf(modules) + modules.length - 1) : p,
    ),
  ]
  const within = (a: string, b: string) => a !== b && !outside(b, a)
  const kept = [...new Set(dirs)].filter((d, _, all) => !all.some((o) => within(d, o)))
  return [
    '--permission',
    '--allow-addons',
    '--disable-warning=SecurityWarning',
    ...kept.map((d) => `--allow-fs-read=${d}`),
  ]
}

const here = dirname(fileURLToPath(import.meta.url))
const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const cliRoot = join(here, '..', '..')

/** The real paths of the packages the host loads and of the project's own dependencies. */
const packageDirs = (root: string): string[] => {
  const req = createRequire(join(cliRoot, 'package.json'))
  const pkg = (name: string) => {
    let dir = dirname(req.resolve(name))
    while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir)
    return dir
  }
  const file = join(root, 'package.json')
  const json = existsSync(file) ? readJson<{ [k: string]: object }>(file) : {}
  const deps = Object.keys({ ...json.dependencies, ...json.devDependencies })
  const local = deps.map((d) => join(root, 'node_modules', d)).filter((d) => existsSync(d))
  const dirs = [cliRoot, pkg('@shaderera/core'), pkg('@napi-rs/canvas'), ...local]
  // Resolution from the project walks up through each ancestor's node_modules by the path as
  // written, before it follows a link or junction to the real path (a frozen revision or an
  // agent stage sits inside the project; pnpm and linked installs use links): allow both.
  const walked: string[] = []
  for (let d = root; ; d = dirname(d)) {
    const modules = join(d, 'node_modules')
    if (existsSync(modules)) walked.push(modules, realpathSync(modules))
    if (dirname(d) === d) break
  }
  return [...dirs.map((d) => realpathSync(d)), ...walked]
}

/**
 * How long the source's open may take: generous, since it loads its footage, fonts and bakes and
 * may compile its pipelines.
 */
export const TIMEOUT = 600_000

/**
 * How long a call after the open may go without a sign of work, by default: an idle timeout, not
 * a limit on the whole call. The clock starts again at every sign the host gives (`alive`): each
 * frame a sequential source steps through, each request it makes of this process (a video or bake
 * frame, the cache), each pipeline it makes. 60 s of silence fails the call; a hung frame sends
 * nothing, so it fails in a minute, not ten. A pipeline (Dawn's compile can take minutes: a path
 * tracer's took 185 s, decision 0006), the reopen after a lost device and every call on a software
 * adapter have the open's allowance instead, and a call has at least 10 times the host's slowest
 * finished call (several hosts sharing one GPU slow every frame). `--timeout` sets one fixed
 * allowance for all of it.
 */
export const CALL_TIMEOUT = 60_000

/** A call's name in a message: `render at t = 1 s`. */
export const callName = (request: { type: string; t?: unknown }) =>
  typeof request.t === 'number' ? `${request.type} at t = ${request.t} s` : request.type

/** A call that went silent too long: what it was, and the way out. */
export const silentError = (who: string, ms: number, request: { type: string; t?: unknown }) =>
  new Error(
    `${who} took longer than ${ms} ms on ${callName(request)} without a sign of work: if it is working, --timeout <s> gives it longer.`,
  )

/**
 * The first frame of a stack that is in the project's own source, through the build's source map
 * (child.ts runs the host with `--enable-source-maps`): its file relative to `root`, and its line.
 * Frames in node_modules, in the build itself (.shaderera) and outside the project are skipped.
 */
export const sourceFrame = (
  stack: string | undefined,
  root: string,
): { file: string; line: number; column: number } | undefined => {
  for (const l of (stack ?? '').split('\n')) {
    const m = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/.exec(l)
    if (!m) continue
    const path = (m[1] as string).startsWith('file:') ? fileURLToPath(m[1] as string) : m[1]
    if (!path || !isAbsolute(path) || outside(root, path)) continue
    const file = relative(root, path).split(sep).join('/')
    if (file.startsWith('node_modules/') || file.startsWith('.shaderera/')) continue
    return { file, line: Number(m[2]), column: Number(m[3]) }
  }
  return undefined
}

/**
 * The error a call to the source failed with, as the host sent it. A throw in the project's own
 * code names the call and where: `render(3) threw: boom (src/composition.ts:26)`, and carries
 * `at` (t, file, line) for its finding (errorFinding). Anything else keeps its message.
 */
export const callError = (
  message: string,
  stack: string | undefined,
  root: string,
  request: { type: string; t?: unknown },
): Error => {
  const at = sourceFrame(stack, root)
  const t = typeof request.t === 'number' ? request.t : undefined
  const error = at
    ? Object.assign(
        new Error(`${request.type}(${t ?? ''}) threw: ${message} (${at.file}:${at.line})`),
        { at: { ...at, ...(t !== undefined ? { t: [t] } : {}) } },
      )
    : new Error(message)
  error.stack = stack
  return error
}

export type HostIdentity = {
  host: 'node' | 'browser'
  node?: string
  /** The browser's product and version, and the flags the host started it with. */
  browser?: string
  flags?: string[]
  /** The WebGPU adapter: vendor, architecture, description. */
  adapter?: string
  /** Which software renderer the adapter is (softwareAdapter); absent on a hardware GPU. */
  software?: string
  /** The project's webgpu (Dawn) version and its device's feature count (Node host). */
  webgpu?: string
  features?: number
}

/** Wall-clock reads inside render calls so far: Date.now and new Date(), performance.now. */
export type ClockReads = { date: number; performance: number }

/**
 * A frame from either host: the layers composited, as **straight** RGBA (colour not multiplied by
 * alpha), rows from the top. Encoders without alpha matte it over black themselves (`matte`).
 */
export type Rendered = {
  pixels: Uint8Array
  layers: { name?: string; final?: boolean }[]
  /** An hdr10 render's light levels, measured from its codes (decision 0023). */
  light?: LightLevels
}

export type Child = {
  /**
   * `rgba` (the default): straight RGBA. `yuv420p`: the frame matted over black as Y'CbCr 4:2:0
   * BT.709 limited range, made on the GPU, for an mp4 (only where `has.yuv`). `rgba64`: straight
   * RGBA at 16 bits a channel, little-endian, for a master (only where `has.deep`). An hdr10
   * render comes out only as `rgb10` or `p010` (core's hdr-compositor.ts), with its light levels.
   */
  render(t: number, intent: 'preview' | 'final', format?: GpuOutput | HdrOutput): Promise<Rendered>
  inspect(t: number): Promise<Json>
  pick(t: number, x: number, y: number): Promise<Pick | null>
  camera(t: number): Promise<Matrices | null>
  /** Renders through these matrices from now on; `null` gives the camera back to the source. */
  override(matrices: Matrices | null): Promise<void>
  /** The source's clips, sampled (a function gain as a curve); null without audio(). */
  audio(): Promise<readonly SampledClip[] | null>
  /** The source's captions (start, end, text in composition seconds); null without captions(). */
  captions(): Promise<readonly Caption[] | null>
  /** The fonts registered through `io.font` (real paths) and the io calls that failed so far. */
  fonts(): Promise<Fonts>
  /** Which host ran the source: what a capture record needs to reproduce it. */
  identity(): Promise<HostIdentity>
  /** How often render read the wall clock since the host opened (counted, never blocked). */
  clock(): Promise<ClockReads>
  /**
   * Its render calls' time and their waits on io.video since the last reset (#454); `reset`
   * starts them again after this reply.
   */
  profile(reset?: boolean): Promise<HostProfile>
  /** How a `sequential` source reached its frames so far; null for any other source. */
  seeks(): Promise<SeekStats | null>
  /**
   * The project's DOM text at t as the host laid it out (browser host: content, font, size,
   * effective opacity, box in frame pixels); [] in the Node host, which has no DOM.
   */
  text(t: number): Promise<TextRun[]>
  close(): Promise<void>
  /**
   * Which optional capabilities the source has. `sequential`: the source is stepped in order, and
   * a seek back restores a checkpoint (`checkpoint: true`) or replays from frame 0.
   */
  readonly has: {
    inspect: boolean
    pick: boolean
    camera: boolean
    sequential?: false | { checkpoint: boolean }
    /** The host composites on the GPU and can return `yuv420p` at this frame size. */
    yuv?: boolean
    /** The host composites on the GPU and can return `rgba64` (16 bits a channel). */
    deep?: boolean
    /**
     * The host renders `hdr10` (decision 0023): frames come only as `p010` (or `rgb10`), with their
     * light levels, and `yuv` and `deep` are false.
     */
    p010?: boolean
  }
}

/** Forks the host, opens the built entry in it and returns one-call-at-a-time access to it. */
export const openChild = async (
  project: Project,
  o: {
    entryFile: string
    trusted?: boolean
    params?: { [key: string]: Json }
    seed?: number
    /** The variant `project.manifest` is already sized for: the source's `host.variant`. */
    variant?: string
    /** The source's `host.range`: `sdr` when absent. */
    range?: Range
    timeoutMs?: number
    /** How long the source's open may take; timeoutMs by default (a test of a hung call raises it). */
    openTimeoutMs?: number
    /** A sequential source's checkpoint spacing in rendering ms; tests force it small. */
    checkpointMs?: number
    /** The bakes' frames, checked against their stamps (project/bakes.ts): what io.bake reads. */
    bakes?: BakeFrames
    /** A draft render's: io.video's frames scaled by this much (createServices). */
    videoScale?: number
    /** `project.manifest` is sized other than the film (open-host's size): the host checks canvases. */
    resized?: boolean
  },
): Promise<Child> => {
  const execArgv = [
    '--enable-source-maps',
    ...(o.trusted ? [] : permissionArgs(project.root, packageDirs(project.root))),
  ]
  const child: ChildProcess = fork(join(here, `host${ext}`), [], {
    execArgv,
    serialization: 'advanced',
    // The project's console output goes to stderr: stdout may be the CLI's result or MCP's stream,
    // and stdin may be MCP's too. Frames go both ways on a pipe of their own (bulk.ts). Its stderr
    // comes through this process, which keeps the end of it for an exit to say why.
    stdio: ['ignore', 2, 'pipe', 'ipc', 'overlapped'],
  })
  hostOfBuild(o.entryFile, 1)
  let said = ''
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(d)
    said = (said + d.toString()).slice(-STDERR_KEPT)
  })
  /** Why the host exited: its code, and its last lines of stderr once they have all come. */
  const exitError = async (code: number | null, signal: NodeJS.Signals | null) => {
    // At most a moment: a process the host started may hold the pipe open after it.
    if (child.stderr && !child.stderr.readableEnded)
      await new Promise((done) => {
        child.stderr?.once('close', done)
        setTimeout(done, 500).unref()
      })
    const last = said.trimEnd().split(/\r?\n/).slice(-STDERR_LINES).join('\n')
    return new Error(
      `The source process exited (${code ?? signal}).${last ? ` Its last output:\n${last}` : ''}`,
    )
  }
  const pipe = child.stdio[BULK_FD] as Socket
  // A host that dies takes its end with it: the call fails through its exit.
  pipe.on('error', () => {})
  const bulk = bulkReader(pipe)
  // What the host asks of this process (the cache, video frames): answered as it comes.
  const services = createServices(project.root, o.bakes, { videoScale: o.videoScale })
  child.on('message', (m: { service?: { id: number; request: ServiceRequest } }) => {
    const s = m.service
    if (!s) return
    services.handle(s.request).then(
      (result) => {
        if (!child.connected) return
        if (!isBulk(result)) return child.send({ serviceReply: { id: s.id, result } })
        // Announced and written in one turn: the host takes them off the pipe in this order.
        child.send({ serviceReply: { id: s.id, bulk: result.byteLength } })
        pipe.write(result)
      },
      (e: unknown) =>
        child.connected &&
        child.send({
          serviceReply: { id: s.id, error: e instanceof Error ? e.message : String(e) },
        }),
    )
  })
  // Its clips' decoders end after it exits; close() waits for them too.
  let released: Promise<void> = Promise.resolve()
  child.once('exit', () => {
    hostOfBuild(o.entryFile, -1)
    // Never awaited when the CLI does not close the host: a failure must not go unhandled.
    released = services.close().catch(() => {})
  })
  // A send to a process that died fails here; the call fails through its exit or its timeout.
  child.on('error', () => {})
  let next = 0
  let queue: Promise<unknown> = Promise.resolve()
  const opening = o.openTimeoutMs ?? o.timeoutMs ?? TIMEOUT
  /** The slowest call that finished so far, in ms. */
  let slowest = 0
  const call = <T>(
    request: Request,
    ms = o.timeoutMs ?? Math.max(CALL_TIMEOUT, 10 * slowest),
  ): Promise<T> => {
    const run = () =>
      new Promise<T>((done, fail) => {
        if (child.killed || !child.connected)
          return fail(new Error('The source process has exited.'))
        const id = next++
        const start = performance.now()
        let limit = ms
        const expire = () => {
          child.kill()
          fail(silentError('The source', limit, request))
        }
        let timer = setTimeout(expire, limit)
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          clearTimeout(timer)
          child.off('message', onMessage)
          void exitError(code, signal).then(fail)
        }
        const onMessage = (m: {
          id: number
          alive?: number
          slow?: boolean
          service?: unknown
          result?: T
          /** The length of the result's `pixels`, which come on the pipe. */
          bulk?: number
          error?: string
          stack?: string
        }) => {
          // A sign of work: a step, a pipeline, a request of this process's (one call at a time).
          if (m.alive === id || m.service) {
            clearTimeout(timer)
            if (m.slow) limit = Math.max(limit, opening)
            timer = setTimeout(expire, limit)
          }
          if (m.id !== id) return
          child.off('message', onMessage).off('exit', onExit)
          if (request.type !== 'open') slowest = Math.max(slowest, performance.now() - start)
          if (m.bulk !== undefined) {
            // Asked for in this turn, so in the order the host wrote them; still timed: bytes
            // that never come (the pipe's end lost) fail the call like a silent host.
            const result = m.result as { pixels?: Uint8Array }
            return void bulk.next(m.bulk).then(
              (pixels) => {
                clearTimeout(timer)
                done({ ...result, pixels } as T)
              },
              (error: Error) => {
                clearTimeout(timer)
                fail(error)
              },
            )
          }
          clearTimeout(timer)
          if (m.error === undefined) return done(m.result as T)
          fail(callError(m.error, m.stack, project.root, request))
        }
        child.on('message', onMessage).once('exit', onExit)
        child.send({ id, request })
      })
    const result = queue.then(run, run)
    queue = result.catch(() => {})
    return result
  }
  const has = await call<Child['has']>(
    {
      type: 'open',
      root: project.root,
      entryFile: o.entryFile,
      manifest: project.manifest,
      params: o.params ?? paramDefaults(project.manifest),
      seed: o.seed ?? project.manifest.seed ?? 0,
      ...(o.variant !== undefined ? { variant: o.variant } : {}),
      ...(o.range ? { range: o.range } : {}),
      checkpointMs: o.checkpointMs,
      ...(o.resized ? { resized: true } : {}),
    },
    opening,
  ).catch((error: Error) => {
    // A source that cannot open must not keep the process alive.
    child.kill()
    // No default export: the finding points at the entry's end, where it goes.
    if (/has no default export/.test(error.message) && !('at' in error)) {
      const entry = resolve(project.root, project.manifest.entry)
      const file = relative(project.root, entry).split(sep).join('/')
      Object.assign(error, { at: { file, line: readFileSync(entry, 'utf8').split('\n').length } })
    }
    throw error
  })
  return {
    has,
    render: (t, intent, format) => call({ type: 'render', t, intent, format }),
    inspect: (t) => call({ type: 'inspect', t }),
    pick: (t, x, y) => call({ type: 'pick', t, x, y }),
    camera: (t) => call({ type: 'camera', t }),
    override: (matrices) => call({ type: 'override', matrices }),
    audio: () => call({ type: 'audio' }),
    captions: () => call({ type: 'captions' }),
    clock: () => call({ type: 'clock' }),
    profile: (reset) => call({ type: 'profile', ...(reset ? { reset } : {}) }),
    fonts: () => call({ type: 'fonts' }),
    seeks: () => call({ type: 'seeks' }),
    text: async () => [],
    identity: () => call({ type: 'identity' }),
    close: async () => {
      if (child.exitCode !== null || child.killed || !child.connected) return released
      const exited = new Promise((done) => child.once('exit', done))
      child.send({ id: -1, request: { type: 'close' } })
      // A source stuck in a loop never reads the message: stop its process instead.
      const stuck = setTimeout(() => child.kill(), 5000)
      await exited
      clearTimeout(stuck)
      await released
    },
  }
}
