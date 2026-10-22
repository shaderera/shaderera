// The child is an execution boundary, NOT a secure sandbox for hostile code: Node 24's
// permission model blocks file writes and child processes, but it does not cover the network and
// native addons are allowed (the canvas is one). Run code you would run with `node` anyway.
import { type ChildProcess, fork } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Caption, Json, Matrices, Pick, Range, SampledClip } from '@shaderera/core'
import type { GpuOutput, HdrOutput, LightLevels, SeekStats } from '@shaderera/core/host'
import { paramDefaults } from '@shaderera/core/host'
import type { TextRun } from '../review/measure.ts'
import type { Fonts, Request } from './host.ts'
import { outside } from './inside.ts'
import type { Project } from './project.ts'
import { type BakeFrames, createServices, type ServiceRequest } from './services.ts'

const modules = `${sep}node_modules${sep}`

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
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const deps = Object.keys({ ...json.dependencies, ...json.devDependencies })
  const local = deps.map((d) => join(root, 'node_modules', d)).filter((d) => existsSync(d))
  // fast-png and jpeg-js decode io.image in the host (runner/image.ts).
  const dirs = [
    cliRoot,
    pkg('@shaderera/core'),
    pkg('@napi-rs/canvas'),
    pkg('fast-png'),
    pkg('jpeg-js'),
    ...local,
  ]
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

/** How long one call may take: generous, because a GPU source's first call compiles its pipelines. */
export const TIMEOUT = 600_000

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
    /** The source's `host.range`: `sdr` when absent. */
    range?: Range
    timeoutMs?: number
    /** A sequential source's checkpoint spacing in rendering ms; tests force it small. */
    checkpointMs?: number
    /** The bakes' frames, checked against their stamps (project/bakes.ts): what io.bake reads. */
    bakes?: BakeFrames
  },
): Promise<Child> => {
  const execArgv = o.trusted ? [] : permissionArgs(project.root, packageDirs(project.root))
  const child: ChildProcess = fork(join(here, `host${ext}`), [], {
    execArgv,
    serialization: 'advanced',
    // The project's console output goes to stderr: stdout may be the CLI's result or MCP's stream,
    // and stdin may be MCP's too.
    stdio: ['ignore', 2, 2, 'ipc'],
  })
  // What the host asks of this process (the cache, video frames): answered as it comes.
  const services = createServices(project.root, o.bakes)
  child.on('message', (m: { service?: { id: number; request: ServiceRequest } }) => {
    const s = m.service
    if (!s) return
    services.handle(s.request).then(
      (result) => child.connected && child.send({ serviceReply: { id: s.id, result } }),
      (e: unknown) =>
        child.connected &&
        child.send({
          serviceReply: { id: s.id, error: e instanceof Error ? e.message : String(e) },
        }),
    )
  })
  child.once('exit', () => services.close())
  // A send to a process that died fails here; the call fails through its exit or its timeout.
  child.on('error', () => {})
  let next = 0
  let queue: Promise<unknown> = Promise.resolve()
  const call = <T>(request: Request): Promise<T> => {
    const run = () =>
      new Promise<T>((done, fail) => {
        if (child.killed || !child.connected)
          return fail(new Error('The source process has exited.'))
        const id = next++
        const timer = setTimeout(() => {
          child.kill()
          fail(
            new Error(
              `The source took longer than ${o.timeoutMs ?? TIMEOUT} ms on ${request.type}.`,
            ),
          )
        }, o.timeoutMs ?? TIMEOUT)
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          clearTimeout(timer)
          child.off('message', onMessage)
          fail(new Error(`The source process exited (${code ?? signal}).`))
        }
        const onMessage = (m: { id: number; result?: T; error?: string; stack?: string }) => {
          if (m.id !== id) return
          clearTimeout(timer)
          child.off('message', onMessage).off('exit', onExit)
          if (m.error === undefined) return done(m.result as T)
          const error = new Error(m.error)
          error.stack = m.stack
          fail(error)
        }
        child.on('message', onMessage).once('exit', onExit)
        child.send({ id, request })
      })
    const result = queue.then(run, run)
    queue = result.catch(() => {})
    return result
  }
  const has = await call<Child['has']>({
    type: 'open',
    root: project.root,
    entryFile: o.entryFile,
    manifest: project.manifest,
    params: o.params ?? paramDefaults(project.manifest),
    seed: o.seed ?? project.manifest.seed ?? 0,
    ...(o.range ? { range: o.range } : {}),
    checkpointMs: o.checkpointMs,
  }).catch((error: unknown) => {
    // A source that cannot open must not keep the process alive.
    child.kill()
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
    fonts: () => call({ type: 'fonts' }),
    seeks: () => call({ type: 'seeks' }),
    text: async () => [],
    identity: () => call({ type: 'identity' }),
    close: async () => {
      if (child.exitCode !== null || child.killed || !child.connected) return
      const exited = new Promise((done) => child.once('exit', done))
      child.send({ id: -1, request: { type: 'close' } })
      // A source stuck in a loop never reads the message: stop its process instead.
      const stuck = setTimeout(() => child.kill(), 5000)
      await exited
      clearTimeout(stuck)
    },
  }
}
