// Runs inside the child process that node/child.ts forks: imports the built entry, opens the
// Source and serves one request at a time over IPC.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas, GlobalFonts, ImageData } from '@napi-rs/canvas'
import type { Host, Json, Layer, Manifest, Matrices, Range, Source } from '@shaderera/core'
import { flattenFrame, frameAt } from '@shaderera/core'
import {
  finalOnly,
  fullDevice,
  type GpuCompositor,
  type GpuLayer,
  type GpuOutput,
  gpuCompositor,
  type HdrCompositor,
  type HdrOutput,
  hdrCompositor,
  type Locate,
  layerInfo,
  lightChecked,
  openSource,
  over,
  type RgbaLayer,
  rangeOf,
  type Seekable,
  type ShaderWatch,
  sampleClips,
  seekable,
  straight,
  watchShaders,
  yuvFits,
} from '@shaderera/core/host'
import { type Ask, extraIo } from '../runner/io.ts'
import { adapterLine, softwareAdapter } from './adapter.ts'
import { insideForRead } from './inside.ts'
import type { ServiceRequest } from './services.ts'

/**
 * The CLI's process does what this sandboxed one may not (write the cache, run ffmpeg): asked over
 * IPC, answered by `serviceReply` (child.ts).
 */
let asked = 0
const replies = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void }>()
process.on('message', (m: { serviceReply?: { id: number; result?: unknown; error?: string } }) => {
  const r = m.serviceReply
  if (!r) return
  const waiting = replies.get(r.id)
  replies.delete(r.id)
  if (r.error === undefined) waiting?.done(r.result)
  else waiting?.fail(new Error(r.error))
})
const askParent = <T>(request: ServiceRequest) =>
  new Promise<T>((done, fail) => {
    const id = asked++
    replies.set(id, { done: done as (v: unknown) => void, fail })
    process.send?.({ service: { id, request } })
  })
const ask: Ask = {
  cacheGet: (hash) => askParent({ op: 'cache-get', hash }),
  cachePut: (hash, bytes) => askParent({ op: 'cache-put', hash, bytes }),
  videoOpen: (path) => askParent({ op: 'video-open', path }),
  videoFrame: (path, index) => askParent({ op: 'video-frame', path, index }),
  videoClose: (path) => askParent({ op: 'video-close', path }),
  bakeOpen: (name) => askParent({ op: 'bake-open', name }),
  bakeFrame: (name, index) => askParent({ op: 'bake-frame', name, index }),
}

export type Open = {
  type: 'open'
  root: string
  entryFile: string
  manifest: Manifest
  params: { [key: string]: Json }
  seed: number
  /** The job's range: `sdr` when absent; `hdr10` needs the manifest's hdr10 and a GPU. */
  range?: Range
  /** A sequential source's checkpoint spacing in rendering ms (the host's default otherwise). */
  checkpointMs?: number
}
export type Request =
  | Open
  | { type: 'render'; t: number; intent: 'preview' | 'final'; format?: GpuOutput | HdrOutput }
  | { type: 'inspect' | 'camera'; t: number }
  | { type: 'pick'; t: number; x: number; y: number }
  | { type: 'override'; matrices: Matrices | null }
  | { type: 'audio' | 'captions' | 'clock' | 'close' | 'fonts' | 'seeks' | 'identity' }

/** The fonts registered through `io.font` and the `io.read`/`io.font` calls that failed. */
export type Fonts = {
  fonts: { family: string; path: string }[]
  failures: { call: 'read' | 'font'; path: string; error: string }[]
}

let source: Source | undefined
let manifest: Manifest
let range: Range = 'sdr'
// Dawn's GPU object is garbage-collected under a live device unless something holds it.
let gpu: unknown
/** The adapter the device came from, for the capture record, and the software renderer it is. */
let adapterInfo: string | undefined
let software: string | undefined
/** The project's webgpu version and how many features its device has, for the capture record. */
let dawnInfo: { webgpu: string; features: number } | undefined

/**
 * Wall-clock reads made while the source renders (G2, decision 0011): `Date.now()`, `new Date()`
 * and `performance.now()` inside `render`. A frame that depends on the clock cannot be rendered
 * again; a library may read it only to log, so the reads are counted and reported, never blocked.
 */
export const clock = { date: 0, performance: 0, rendering: false }
{
  const now = Date.now
  Date.now = () => {
    if (clock.rendering) clock.date++
    return now()
  }
  globalThis.Date = new Proxy(Date, {
    construct(target, args, newTarget) {
      if (args.length === 0 && clock.rendering) clock.date++
      return Reflect.construct(target, args, newTarget)
    },
  })
  const perf = performance.now.bind(performance)
  performance.now = () => {
    if (clock.rendering) clock.performance++
    return perf()
  }
}

/** Runs a render with the clock counted. */
const counted = async <T>(run: () => Promise<T>): Promise<T> => {
  clock.rendering = true
  try {
    return await run()
  } finally {
    clock.rendering = false
  }
}

/**
 * One Dawn per process: a second native Dawn (a library that installs its own `webgpu`, such as a
 * pinned older version) crashes the process later, at random. Refused here, as it loads, by name.
 */
const dawns = new Set<string>()
{
  const dlopen = process.dlopen
  process.dlopen = ((module: unknown, filename: string, ...rest: unknown[]) => {
    if (/dawn\.node$/i.test(filename)) {
      // Windows hands dlopen a namespaced path (\\?\C:\...), which realpath does not take.
      const real = realpathSync(filename.replace(/^\\\\\?\\/, ''))
      const first = [...dawns][0]
      if (first !== undefined && first !== real)
        throw new Error(
          `A second Dawn is loading (${real}) beside the project's (${first}): two in one process crash it. ` +
            'Give the library host.gpu (vgpu: initFromDevice; three.js: its WebGPURenderer on a given device) and keep one webgpu in node_modules (shaderera doctor lists them).',
        )
      dawns.add(real)
    }
    return (dlopen as (...a: unknown[]) => unknown).call(process, module, filename, ...rest)
  }) as typeof process.dlopen
}
/** Why the device was lost, until the source is reopened on a new one. */
let lost: string | undefined
/** The last open, to run again on a new device after the old one was lost. */
let opened: Open | undefined
/** WebGPU errors nothing caught (an invalid shader or pipeline): each fails the call it came in. */
const gpuErrors: string[] = []
/** The compiler's own errors for the shaders the source creates (B2, decision 0011). */
let shaders: ShaderWatch | undefined
const fonts: Fonts = { fonts: [], failures: [] }

/** Runs an io call, recording its failure before rethrowing it. */
const recorded = async <T>(call: 'read' | 'font', path: string, run: () => Promise<T>) => {
  try {
    return await run()
  } catch (e) {
    fonts.failures.push({ call, path, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

const SKIP = new Set(['node_modules', 'out', 'dist', 'versions', '.shaderera', '.git'])
const CODE = /\.(wgsl|ts|js|mjs|tsx|jsx)$/

/**
 * Where a line of WGSL is in the project: `path:line` when exactly one line of the project's own
 * code matches it. Read once, on the first error.
 */
const locator = (root: string): Locate => {
  let lines: { at: string; text: string }[] | undefined
  const walk = (dir: string, rel: string): { at: string; text: string }[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (SKIP.has(e.name)) return []
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) return walk(join(dir, e.name), path)
      if (!CODE.test(e.name)) return []
      return readFileSync(join(dir, e.name), 'utf8')
        .split(/\r?\n/)
        .map((text, i) => ({ at: `${path}:${i + 1}`, text: text.trim() }))
    })
  return (line) => {
    lines ??= walk(root, '')
    const want = line.trim()
    const hits = lines.filter((l) => l.text === want)
    return hits.length === 1 ? hits[0]?.at : undefined
  }
}

/** A WebGPU device from the project's own `webgpu` package (Dawn), or undefined without one. */
const gpuDevice = async (root: string): Promise<GPUDevice | undefined> => {
  let dawn: { create(flags: string[]): GPU; globals: object }
  try {
    dawn = createRequire(join(root, 'package.json'))('webgpu')
  } catch {
    return undefined
  }
  Object.assign(globalThis, dawn.globals)
  gpu = dawn.create([])
  const adapter = await (gpu as GPU).requestAdapter()
  if (!adapter) process.stderr.write('webgpu is installed, but Dawn found no GPU adapter here.\n')
  const info = adapter?.info
  if (info) {
    adapterInfo = adapterLine(info)
    software = softwareAdapter(info)
  }
  try {
    const version = createRequire(join(root, 'package.json'))('webgpu/package.json').version
    dawnInfo = { webgpu: String(version), features: adapter ? adapter.features.size : 0 }
  } catch {
    // A webgpu without its package.json in exports: no version to record.
  }
  // Every feature and limit the adapter has, as the browser host asks (fullDevice).
  const device = adapter ? await adapter.requestDevice(fullDevice(adapter)) : undefined
  shaders = device ? watchShaders(device, locator(root)) : undefined
  device?.addEventListener('uncapturederror', (e) => {
    gpuErrors.push((e as GPUUncapturedErrorEvent).error.message)
  })
  void device?.lost.then((info) => {
    lost = info.message || info.reason
  })
  return device
}

/** The frame's compositor on the source's device; none without `webgpu` (decision 0007). */
let compositor: GpuCompositor | undefined
/** An hdr10 render's compositor in its place (decision 0023): nothing of it composites in SDR. */
let hdr: HdrCompositor | undefined

type Canvas = { getContext(kind: '2d'): CanvasRenderingContext2D }
const isTexture = (color: unknown): color is GPUTexture =>
  typeof GPUTexture !== 'undefined' && color instanceof GPUTexture
const isCanvas = (color: unknown): color is Canvas =>
  typeof (color as Partial<Canvas>).getContext === 'function'

/** A layer as bytes or a texture, with its depth: what the compositors take. */
const toGpuLayer = (layer: Layer, width: number, height: number): GpuLayer => {
  const color = layer.color as unknown
  const depth = layer.depth ? { depth: { data: layer.depth.data, soft: layer.depth.soft } } : {}
  const { alpha, light } = layer as Pick<GpuLayer, 'alpha' | 'light'>
  // Only a float texture carries light (lightChecked).
  if (color instanceof Uint8Array || color instanceof Uint8ClampedArray || isTexture(color))
    return { color, alpha, ...depth, ...(light ? { light } : {}) }
  if (isCanvas(color))
    return {
      color: color.getContext('2d').getImageData(0, 0, width, height).data,
      alpha: 'straight',
      ...depth,
    }
  throw new Error(
    'In Node a layer must be a canvas, RGBA bytes or a GPUTexture; ImageBitmap and VideoFrame are browser-only.',
  )
}

/** Without a GPU there is no texture: a layer is bytes. */
const asRgba = ({ color, alpha, depth }: GpuLayer): RgbaLayer => {
  if (!(color instanceof Uint8Array || color instanceof Uint8ClampedArray))
    throw new Error('A GPUTexture layer needs a host with a GPU.')
  return { data: color, alpha, ...(depth ? { depth } : {}) }
}

/**
 * Straight RGBA without a GPU: Skia composites `over` (each canvas drawn as it is, bytes put on a
 * canvas first); layers with depth go through `over`, the only CPU depth test.
 */
const cpuComposite = (layers: readonly Layer[], width: number, height: number): Uint8Array => {
  if (layers.some((l) => l.depth)) {
    const rgba = layers.map((l) => asRgba(toGpuLayer(l, width, height)))
    return new Uint8Array(
      straight({ alpha: 'premultiplied', data: over(rgba, width, height) }).buffer,
    )
  }
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  for (const layer of layers) {
    const color = layer.color as unknown
    if (isCanvas(color)) {
      ctx.drawImage(color as never, 0, 0, width, height)
      continue
    }
    const { data, alpha } = asRgba(toGpuLayer(layer, width, height))
    const bytes = createCanvas(width, height)
    bytes
      .getContext('2d')
      .putImageData(new ImageData(straight({ data, alpha }), width, height), 0, 0)
    ctx.drawImage(bytes, 0, 0)
  }
  return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)
}

const handle = async (m: Request): Promise<unknown> => {
  if (m.type === 'open') {
    opened = m
    manifest = m.manifest
    // In Node a source may find its project files from the working directory.
    process.chdir(m.root)
    const device = await gpuDevice(m.root)
    range = rangeOf(m.manifest, m.range, device)
    try {
      compositor?.destroy()
      hdr?.destroy()
    } catch {
      // Its device was lost: nothing to free.
    }
    const { width, height, hdr10 } = m.manifest
    // rangeOf gave hdr10 only for a manifest with hdr10, on a device.
    hdr =
      range === 'hdr10' && device && hdr10 ? hdrCompositor(device, width, height, hdr10) : undefined
    compositor = device && !hdr ? gpuCompositor(device, width, height) : undefined
    const read = (path: string) =>
      recorded(
        'read',
        path,
        async () => new Uint8Array(await readFile(insideForRead(m.root, path))),
      )
    const host: Host = {
      manifest: m.manifest,
      params: m.params,
      seed: m.seed,
      range,
      gpu: device,
      io: {
        read,
        ...extraIo(read, ask),
        canvas: (w, h) => createCanvas(w, h) as unknown as OffscreenCanvas,
        font: (path, family) =>
          recorded('font', path, async () => {
            const file = insideForRead(m.root, path)
            if (!GlobalFonts.registerFromPath(file, family)) {
              throw new Error(`Could not load the font ${path}.`)
            }
            fonts.fonts.push({ family, path: file })
          }),
      },
    }
    const module = await import(pathToFileURL(m.entryFile).href)
    const open = () => openSource(module, host)
    source = m.manifest.sequential
      ? await seekable(open, m.manifest, { checkpointMs: m.checkpointMs })
      : await open()
    return {
      inspect: !!source.inspect,
      pick: !!source.pick,
      camera: !!source.camera,
      sequential: m.manifest.sequential
        ? { checkpoint: (source as Seekable).stats().checkpoint }
        : false,
      yuv: !!compositor && yuvFits(m.manifest.width, m.manifest.height),
      deep: !!compositor,
    }
  }
  const s = source as Source
  switch (m.type) {
    case 'render': {
      const { width, height } = manifest
      const frame = frameAt(m.t, manifest.fps)
      const layers = lightChecked(
        finalOnly(
          flattenFrame(
            await counted(() => s.render(m.t, { width, height, intent: m.intent, frame })),
          ),
          m.intent,
          m.t,
        ),
        range,
      )
      if (hdr) {
        if (m.format !== 'rgb10' && m.format !== 'p010')
          throw new Error(
            `An hdr10 render comes out as rgb10 or p010, not ${m.format ?? 'rgba'}: nothing of it is composited in SDR.`,
          )
        const { bytes, light } = await hdr.composite(
          layers.map((l) => toGpuLayer(l, width, height)),
          m.format,
          frame,
        )
        return { pixels: bytes, layers: layers.map(layerInfo), light }
      }
      // Straight RGBA by default, as the browser host returns it (docs/determinism.md,
      // Pixels); yuv420p for an mp4 and rgba64 for a master, made on the GPU.
      const format = m.format ?? 'rgba'
      if (format === 'rgb10' || format === 'p010')
        throw new Error(`${format} comes from an hdr10 render; this one is SDR.`)
      if (format !== 'rgba' && !compositor)
        throw new Error(`${format} is made on the GPU: this project has no \`webgpu\` (Dawn).`)
      const pixels = compositor
        ? await compositor.composite(
            layers.map((l) => toGpuLayer(l, width, height)),
            format,
          )
        : cpuComposite(layers, width, height)
      return { pixels, layers: layers.map(layerInfo) }
    }
    case 'inspect':
      return s.inspect ? s.inspect(m.t) : null
    case 'pick':
      return s.pick ? s.pick(m.t, m.x, m.y) : null
    case 'camera':
      return s.camera ? s.camera.get(m.t) : null
    case 'override':
      return s.camera?.override?.(m.matrices) ?? null
    case 'audio':
      // A function gain cannot cross to the parent: it goes as samples (sampleClips).
      return s.audio ? sampleClips(await s.audio(), manifest.duration) : null
    case 'captions':
      return s.captions ? s.captions() : null
    case 'clock':
      return { date: clock.date, performance: clock.performance }
    case 'fonts':
      return fonts
    case 'identity':
      return {
        host: 'node',
        node: process.version,
        ...(adapterInfo ? { adapter: adapterInfo } : {}),
        ...(software ? { software } : {}),
        ...(dawnInfo ?? {}),
      }
    case 'seeks':
      return manifest.sequential ? (s as Seekable).stats() : null
    case 'close':
      s.dispose?.()
      process.exit(0)
  }
}

process.on('message', async ({ id, request }: { id: number; request: Request }) => {
  // A reply to this host's own request (askParent) is not a request.
  if (request === undefined) return
  try {
    // A lost device fails the call it happened in; the next call reopens on a new device.
    if (lost !== undefined && opened && request.type !== 'open' && request.type !== 'close') {
      lost = undefined
      source?.dispose?.()
      await handle(opened)
    }
    gpuErrors.length = 0
    const result = await handle(request)
    // Errors are reported as events after the call that made them: let them arrive.
    await new Promise((done) => setImmediate(done))
    if (lost !== undefined)
      throw new Error(
        `The WebGPU device was lost (${lost}): this call failed; the next one reopens the source on a new device.`,
      )
    // A shader that did not compile is named by the compiler, not by the pipelines it broke.
    const compile = (await shaders?.settle()) ?? []
    if (compile.length > 0)
      throw new Error(
        `${compile.length} shader error(s) during this call, so its result is not trusted:\n${compile.join('\n')}`,
      )

    if (gpuErrors.length > 0)
      throw new Error(
        `WebGPU reported ${gpuErrors.length} error(s) during this call, so its result is not trusted: ${gpuErrors[0]}`,
      )
    process.send?.({ id, result: result ?? null })
  } catch (e) {
    // Dawn rejects a call on a lost device (an AbortError) before `lost` resolves: let it, so
    // the error says why.
    if (lost === undefined) await new Promise((done) => setImmediate(done))
    const error = e instanceof Error ? e : new Error(String(e))
    const message =
      lost === undefined || error.message.includes('device was lost')
        ? error.message
        : `The WebGPU device was lost (${lost}): this call failed (${error.message}); the next one reopens the source on a new device.`
    process.send?.({ id, error: message, stack: error.stack })
  }
})
