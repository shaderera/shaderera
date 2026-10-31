// The runner's worker, on the runner origin under its CSP: the only caller of the project's Source.
import type {
  Caption,
  Io,
  Json,
  Layer,
  Manifest,
  Matrices,
  Pick,
  Range,
  SampledClip,
  Source,
} from '@shaderera/core'
import { checkDeterminism, flattenFrame, frameAt } from '@shaderera/core'
import {
  checkManifest,
  finalOnly,
  fullDevice,
  type GpuCompositor,
  type GpuLayer,
  type GpuOutput,
  gpuCompositor,
  type HdrCompositor,
  type HdrOutput,
  hdrCompositor,
  type LightLevels,
  layerInfo,
  lightChecked,
  openSource,
  over,
  paramDefaults,
  rangeOf,
  type Seekable,
  type ShaderWatch,
  sampleClips,
  seekable,
  straight,
  watchShaders,
  withVariant,
  yuvFits,
} from '@shaderera/core/host'
import * as Comlink from 'comlink'
import { type PcmForm, packClips, toPage } from './audio.ts'
import { type Ask, extraIo, type StillSize, stillOf } from './io.ts'
import {
  type FrameTimer,
  type RenderTime,
  renderTime,
  resetRenderTime,
  timeFrame,
  timeRender,
} from './render-time.ts'

export type Capabilities = {
  inspect: boolean
  pick: boolean
  camera: boolean
  /** `camera.override`: the source can render through another camera (Explore 3D). */
  override: boolean
  audio: boolean
  /** Stepped in order; a seek back restores a checkpoint or replays from frame 0. */
  sequential: false | { checkpoint: boolean }
  /** The worker composites on the GPU and can return yuv420p at this frame size. */
  yuv: boolean
  /** The worker composites on the GPU and can return rgba64 (16 bits a channel). */
  deep: boolean
  /** An hdr10 render: frames come as p010 (or rgb10), with their light levels; none in SDR. */
  p010: boolean
}
export type RenderedLayer = { bitmap: ImageBitmap; name?: string; final?: boolean }

/**
 * Wall-clock reads made while the source renders (G2, decision 0011), as the Node host counts
 * them: a frame that depends on the clock cannot be rendered again. Counted, never blocked.
 */
const clock = { date: 0, performance: 0, rendering: false }
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
/** A render call with the clock counted, timed (render-time.ts): as a frame's when `timer` is given. */
const counted = async <T>(run: () => Promise<T>, timer?: FrameTimer): Promise<T> =>
  (timer ? timer.render : timeRender)(async () => {
    clock.rendering = true
    try {
      return await run()
    } finally {
      clock.rendering = false
    }
  })

let source: Source | undefined
let manifest: Manifest
/** The open source's `host.range`. */
let range: Range = 'sdr'
/** The latest render's signal: a newer render aborts it, because a scrub made it stale. */
let latest: AbortController | undefined
/** The Studio's exploration camera: applied to preview renders only, kept across a reopen. */
let explore: Matrices | null = null
/** While an export runs, the source must not reopen with other params. */
let exporting = false

/**
 * Where the open source's files are served: the project, or a revision's frozen copy. A host that
 * built the runner into its own worker sets the project's (`configureRunner`).
 */
let files = '/'
/** The variant this runner opens when `open` names none (configureRunner). */
let runnerVariant: string | undefined
let base = files
const url = (path: string): string => `${base}${path.replace(/^\.?\//, '')}`

const read = async (path: string) => {
  try {
    const response = await fetch(url(path))
    if (!response.ok) throw new Error(String(response.status))
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`io.read(${path}): ${error instanceof Error ? error.message : error}`)
  }
}

/** The CLI's process, through the runner server (runner-plugin.ts, SERVICE_PATH). */
const service = async (op: string, query: Record<string, string>, body?: Uint8Array) => {
  // @ts-expect-error: served by the runner plugin.
  const token: string = (await import('/__shaderera/token.js')).default
  // Beside the files: the runner server's root, or the base a studio frame is served under.
  const response = await fetch(
    `${files}__shaderera/service/${op}?${new URLSearchParams({ ...query, token })}`,
    {
      method: body ? 'POST' : 'GET',
      ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
    },
  )
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await response.text())
  return response
}
/** The services' answers: the CLI's process, unless a host configured its own. */
const ask: Ask = {
  image: async (path, maxSize) => {
    // The path the CLI's process reads: a revision's own copy when one is open (`base`).
    const served = url(path).slice(files.length)
    const opened = await service('image-open', {
      path: served,
      ...(maxSize === undefined ? {} : { maxSize: String(maxSize) }),
    })
    const size = (await (opened as Response).json()) as StillSize
    if (size.local) return null
    const data = (await service('image-data', { key: size.key })) as Response
    return stillOf(size, new Uint8Array(await data.arrayBuffer()))
  },
  cacheGet: async (hash) => {
    const r = await service('cache-get', { hash })
    return r ? new Uint8Array(await r.arrayBuffer()) : null
  },
  cachePut: async (hash, bytes) => void (await service('cache-put', { hash }, bytes)),
  videoOpen: async (path, declared) =>
    (await (
      await service('video-open', { path, ...(declared ? { declared: '1' } : {}) })
    )?.json()) as never,
  videoFrame: async (path, index, format) =>
    new Uint8Array(
      await (
        (await service('video-frame', { path, index: String(index), format })) as Response
      ).arrayBuffer(),
    ),
  videoClose: async (path) => void (await service('video-close', { path })),
  bakeOpen: async (name) => (await (await service('bake-open', { name }))?.json()) as never,
  bakeFrame: async (name, index) =>
    new Uint8Array(
      await (
        (await service('bake-frame', { name, index: String(index) })) as Response
      ).arrayBuffer(),
    ),
}

/**
 * The runner's host hook. A host that builds the runner into a worker of its own (the web player:
 * player/worker.ts) calls this once, before the page connects:
 *
 * - `files`: where `io.read` finds the project's files, an absolute URL ending in `/`. The runner
 *   server's root (`/`) otherwise.
 * - `ask`: what answers `io.video`, `io.cache` and `io.bake` (the `Ask` in io.ts), in place of the
 *   CLI's process behind the runner server. Without it, that process answers, beside `files` (the
 *   studio's frame of the runner server, docs/studio.md).
 *
 * Such a runner opens its own project only, never a saved revision.
 */
export const configureRunner = (o: {
  files: string
  ask?: Ask
  /** The variant `open` applies when it names none: the studio's `/runner?variant=`. */
  variant?: string
}): void => {
  if (!/^[a-z][a-z0-9+.-]*:.*\/$/i.test(o.files))
    throw new Error(`configureRunner: files is an absolute URL ending in /, not ${o.files}.`)
  files = base = o.files
  if (o.ask) Object.assign(ask, o.ask)
  if (o.variant !== undefined) runnerVariant = o.variant
}

const io: Io = {
  read,
  ...extraIo(read, ask),
  canvas: (width, height) => new OffscreenCanvas(width, height),
  font: async (path, family) => {
    const face = new FontFace(family, (await io.read(path)) as Uint8Array<ArrayBuffer>)
    await face.load()
    ;(self as unknown as { fonts: FontFaceSet }).fonts.add(face)
  },
}

/** The worker's WebGPU device, made once, when the browser has WebGPU; again after a loss. */
let device: Promise<GPUDevice | undefined> | undefined
/** Why the device was lost, until the source is reopened on a new one. */
let lost: string | undefined
/** WebGPU errors nothing caught (an invalid shader or pipeline): each fails the call it came in. */
const gpuErrors: string[] = []
/** The compiler's own errors for the shaders the source creates (decision 0011). */
let shaders: ShaderWatch | undefined
/**
 * The worker's device, with every feature and limit the adapter allows (fullDevice, as the Node
 * host asks: a path tracer's buffers pass the defaults), and its errors on the console instead of
 * a render that never returns.
 */
const gpuDevice = () =>
  (device ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return undefined
    const gpu = await adapter.requestDevice(fullDevice(adapter))
    shaders = watchShaders(gpu)
    gpu.addEventListener('uncapturederror', (e) => {
      const message = (e as GPUUncapturedErrorEvent).error.message
      console.error(`WebGPU: ${message}`)
      gpuErrors.push(message)
    })
    void gpu.lost.then((info) => {
      device = undefined
      lost = info.message || info.reason
    })
    return gpu
  })())

/** The frame's compositor on the worker's device (decision 0007); none without WebGPU. */
let compositor: { gpu: GPUDevice; c: GpuCompositor } | undefined
const compositorFor = async (): Promise<GpuCompositor | undefined> => {
  const gpu = await gpuDevice()
  if (!gpu) return undefined
  const { width, height } = manifest
  const c = compositor?.c
  if (compositor?.gpu !== gpu || c?.width !== width || c?.height !== height) {
    try {
      c?.destroy()
    } catch {
      // Its device was lost: nothing to free.
    }
    compositor = { gpu, c: gpuCompositor(gpu, width, height) }
  }
  return compositor?.c
}

/** An hdr10 render's compositor (decision 0023), for the manifest's hdr10 it was made for. */
let hdr: { gpu: GPUDevice; hdr10: unknown; c: HdrCompositor } | undefined
const hdrFor = async (): Promise<HdrCompositor> => {
  const gpu = await gpuDevice()
  const { width, height, hdr10 } = manifest
  // rangeOf gave hdr10 only for a manifest with hdr10, on a device.
  if (!gpu || !hdr10) throw new Error("An hdr10 render needs WebGPU and the manifest's hdr10.")
  const c = hdr?.c
  if (hdr?.gpu !== gpu || hdr.hdr10 !== hdr10 || c?.width !== width || c?.height !== height) {
    try {
      c?.destroy()
    } catch {
      // Its device was lost: nothing to free.
    }
    hdr = { gpu, hdr10, c: hdrCompositor(gpu, width, height, hdr10) }
  }
  return hdr.c
}

const isTexture = (color: unknown): color is GPUTexture =>
  typeof GPUTexture !== 'undefined' && color instanceof GPUTexture

/** A layer as the compositor takes it: an image not at the frame's size is drawn to it first. */
const toGpuLayer = (layer: Layer, width: number, height: number): GpuLayer => {
  const color = layer.color
  const depth = layer.depth ? { depth: { data: layer.depth.data, soft: layer.depth.soft } } : {}
  if (color instanceof Uint8Array || color instanceof Uint8ClampedArray || isTexture(color)) {
    // Only a float texture carries light (lightChecked).
    const { alpha, light } = layer as { alpha: GpuLayer['alpha']; light?: GpuLayer['light'] }
    return { color, alpha, ...depth, ...(light ? { light } : {}) }
  }
  const w = 'displayWidth' in color ? color.displayWidth : color.width
  const h = 'displayHeight' in color ? color.displayHeight : color.height
  if (w === width && h === height) return { color, alpha: 'premultiplied', ...depth }
  const canvas = new OffscreenCanvas(width, height)
  ;(canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(
    color,
    0,
    0,
    width,
    height,
  )
  return { color: canvas, alpha: 'premultiplied', ...depth }
}

const toBitmap = async (layer: Layer, width: number, height: number): Promise<ImageBitmap> => {
  const color = layer.color
  if (isTexture(color)) {
    // The Studio shows each layer as a bitmap: a texture comes back through the compositor.
    const c = await compositorFor()
    if (!c) throw new Error('A GPUTexture layer needs WebGPU.')
    const bytes = await c.composite([toGpuLayer(layer, width, height)], 'rgba')
    return createImageBitmap(
      new ImageData(new Uint8ClampedArray(bytes.buffer as ArrayBuffer), width, height),
    )
  }
  if (!(color instanceof Uint8Array || color instanceof Uint8ClampedArray)) {
    return createImageBitmap(color as OffscreenCanvas | ImageBitmap | VideoFrame)
  }
  const alpha = 'alpha' in layer ? layer.alpha : 'straight'
  return createImageBitmap(new ImageData(straight({ data: color, alpha }), width, height))
}

/** A layer's straight RGBA bytes, however it came. */
const toBytes = async (layer: Layer, width: number, height: number): Promise<Uint8ClampedArray> => {
  const bitmap = await toBitmap(layer, width, height)
  const ctx = new OffscreenCanvas(width, height).getContext(
    '2d',
  ) as OffscreenCanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return ctx.getImageData(0, 0, width, height).data
}

/**
 * A frame whose layers carry depth, composited `over` with the depth test into one layer (the
 * canvas draws none of it); a frame without depth comes back as it is.
 */
const depthTested = async (
  layers: readonly Layer[],
  width: number,
  height: number,
): Promise<readonly Layer[]> => {
  if (!layers.some((l) => l.depth)) return layers
  const rgba = await Promise.all(
    layers.map(async (l) => ({
      data: await toBytes(l, width, height),
      alpha: 'straight' as const,
      ...(l.depth ? { depth: { data: l.depth.data, soft: l.depth.soft } } : {}),
    })),
  )
  const name = layers.map((l) => l.name ?? 'layer').join(' + ')
  return [{ color: over(rgba, width, height), alpha: 'premultiplied', name }]
}

/*
 * The project's DOM (manifest.dom) lives on the runner page, where the bridge lays it out and draws
 * it (HTML-in-Canvas); the worker asks for it at t over this port, before each render.
 */
let domPort: MessagePort | undefined
let asked = 0
const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
const domCall = <T>(message: object, timeoutMs = 60_000): Promise<T> =>
  new Promise<T>((ok, fail) => {
    if (domPort === undefined) return fail(new Error('No runner page to draw the DOM on.'))
    const id = ++asked
    const timer = setTimeout(() => {
      waiting.delete(id)
      fail(new Error(`The DOM did not answer in ${timeoutMs / 1000} s.`))
    }, timeoutMs)
    waiting.set(id, {
      ok: (v) => {
        clearTimeout(timer)
        ok(v as T)
      },
      fail: (e) => {
        clearTimeout(timer)
        fail(e)
      },
    })
    domPort.postMessage({ ...message, id })
  })
/** The DOM drawn at t, when the manifest has one. */
const domAt = async (t: number): Promise<ImageBitmap | undefined> =>
  manifest.dom === undefined ? undefined : (await domCall<{ bitmap: ImageBitmap }>({ t })).bitmap

// One call at a time; a render that arrives while one is queued replaces it (latest wins).
type Job = {
  render: boolean
  run: () => Promise<unknown>
  done: (v: unknown) => void
  fail: (e: unknown) => void
}
const queue: Job[] = []
let running = false
/** The last open, to run again on a new device after the old one was lost. */
let reopen: (() => Promise<unknown>) | undefined
const pump = async () => {
  if (running) return
  running = true
  for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
    try {
      // A lost device fails the call it happened in; the next call reopens on a new device.
      if (lost !== undefined && reopen) {
        lost = undefined
        await reopen()
      }
      gpuErrors.length = 0
      const result = await job.run()
      // Errors are reported as events after the call that made them: let them arrive.
      await new Promise((done) => setTimeout(done, 0))
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
      job.done(result)
    } catch (error) {
      job.fail(error)
    }
  }
  running = false
}
const enqueue = <T>(render: boolean, run: () => Promise<T>): Promise<T> =>
  new Promise<T>((done, fail) => {
    if (render) {
      const i = queue.findIndex((job) => job.render)
      if (i >= 0) queue.splice(i, 1)[0]?.fail(new Error('superseded'))
    }
    queue.push({ render, run, done: done as (v: unknown) => void, fail })
    void pump()
  })

const opened = (): Source => {
  if (source === undefined) throw new Error('The runner has no open source.')
  return source
}

export type OpenOptions = {
  /** Replaces the manifest's defaults (and the variant's): the preview's params, or a job's. */
  params?: { [key: string]: Json }
  /** The source's `host.seed` (a job's own); by default the manifest's, or 0. */
  seed?: number
  /** The source's `host.range` (a job's own): `sdr` when absent. */
  range?: Range
  /** A saved revision, opened from its frozen copy under .shaderera/revisions/: a render job. */
  revision?: string
  /** A variant from shaderera.json, applied to the manifest the source opens with. */
  variant?: string
  /** Overrides the manifest's frame size: review's resized reopen. */
  size?: { width: number; height: number }
}

const api = {
  /** Opens the project's Source, or a job's frozen revision, with a variant and params. */
  open: (o: OpenOptions = {}) => {
    reopen = async () => {
      if (exporting) throw new Error('An export is running; parameters apply after it ends.')
      if (o.revision !== undefined && !/^[0-9a-f]{16}$/.test(o.revision))
        throw new Error(`Not a revision id: ${o.revision}`)
      source?.dispose?.()
      if (o.revision !== undefined && files !== '/')
        throw new Error('This runner opens its own project, not a saved revision.')
      base = o.revision ? `/.shaderera/revisions/${o.revision}/` : files
      const declared = checkManifest(await (await fetch(url('shaderera.json'))).json())
      const variant = withVariant(declared, o.variant ?? runnerVariant)
      manifest = { ...variant.manifest, ...o.size }
      const module: unknown = o.revision
        ? await import(/* @vite-ignore */ url(declared.entry))
        : // @ts-expect-error: served by the runner plugin, which re-exports manifest.entry.
          await import('/__shaderera/entry.js')
      const gpu = await gpuDevice()
      range = rangeOf(manifest, o.range, gpu)
      const host = {
        manifest,
        params: o.params ?? { ...paramDefaults(manifest), ...variant.params },
        seed: o.seed ?? manifest.seed ?? 0,
        ...(o.variant !== undefined ? { variant: o.variant } : {}),
        range,
        io,
        gpu,
      }
      // A revision's DOM is its own frozen file, beside its entry; never the live one.
      if (manifest.dom !== undefined)
        await domCall({
          mount: {
            manifest,
            params: host.params,
            ...(o.variant !== undefined ? { variant: o.variant } : {}),
            ...(o.revision ? { module: url(manifest.dom) } : {}),
          },
        })
      const open = () => openSource(module, host, manifest.entry.replace(/^\.\//, ''))
      // A sequential source steps skipped frames itself; each gets the DOM drawn at its own t.
      const prepare = async (at: number) => ({ dom: await domAt(at) })
      source = manifest.sequential ? await seekable(open, manifest, { prepare }) : await open()
      const s = source
      const capabilities: Capabilities = {
        inspect: typeof s.inspect === 'function',
        pick: typeof s.pick === 'function',
        camera: s.camera !== undefined,
        override: typeof s.camera?.override === 'function',
        audio: typeof s.audio === 'function',
        sequential: manifest.sequential
          ? { checkpoint: (s as Seekable).stats().checkpoint }
          : false,
        // An hdr10 render has neither: it comes out as rgb10 or p010 only.
        yuv: !!host.gpu && range === 'sdr' && yuvFits(manifest.width, manifest.height),
        deep: !!host.gpu && range === 'sdr',
        p010: range === 'hdr10',
      }
      if (explore) s.camera?.override?.(explore)
      return { manifest, capabilities }
    }
    return enqueue(false, reopen)
  },
  render: (t: number, intent: 'preview' | 'final' = 'preview') => {
    latest?.abort(new Error('superseded'))
    latest = new AbortController()
    const { signal } = latest
    return enqueue(true, async () => {
      // The preview draws bitmaps in SDR, which would clip the light: refused as pixels(t) is.
      // The engine has no tone map; the film's SDR version is an open with range 'sdr' (0023).
      if (range === 'hdr10')
        throw new Error(
          "An hdr10 render comes out as rgb10 or p010, not a preview: nothing of it is composited in SDR. Open with range 'sdr' for the film's own SDR version.",
        )
      const { width, height } = manifest
      const dom = await domAt(t)
      const layers: RenderedLayer[] = []
      // The DOM bitmap is the host's: closed once the frame's layers are copied out of it.
      try {
        signal.throwIfAborted()
        const frame = await counted(() =>
          opened().render(t, {
            width,
            height,
            intent,
            signal,
            frame: frameAt(t, manifest.fps),
            ...(dom ? { dom } : {}),
          }),
        )
        for (const layer of await depthTested(
          lightChecked(finalOnly(flattenFrame(frame), intent, t), range),
          width,
          height,
        )) {
          layers.push({
            bitmap: await toBitmap(layer, width, height),
            name: layer.name,
            final: layer.final,
          })
        }
      } finally {
        dom?.close()
      }
      return Comlink.transfer(
        { layers },
        layers.map((l) => l.bitmap),
      )
    })
  },
  inspect: (t: number) =>
    enqueue(false, async (): Promise<Json | null> => (await opened().inspect?.(t)) ?? null),
  pick: (t: number, x: number, y: number) =>
    enqueue(false, async (): Promise<Pick | null> => (await opened().pick?.(t, x, y)) ?? null),
  camera: (t: number) =>
    enqueue(false, async (): Promise<Matrices | null> => (await opened().camera?.get(t)) ?? null),
  /** The Studio's exploration camera for previews; `null` gives control back to the source. */
  override: (matrices: Matrices | null) =>
    enqueue(false, async () => {
      explore = matrices
      opened().camera?.override?.(matrices)
    }),
  /** Marks an export running (no reopen) or ended. */
  exporting: (on: boolean) =>
    enqueue(false, async () => {
      exporting = on
    }),
  /**
   * The source's clips, a function gain sampled (sampleClips). With 'buffers', sound made in code
   * comes as transferred Float32Arrays; without, as base64 float32, for pages that predate it
   * (audio.ts). A throw in the source's audio() fails the call, naming it.
   */
  audio: (pcm?: PcmForm) =>
    enqueue(false, async (): Promise<readonly SampledClip[]> => toPage(await clips(), pcm)),
  /**
   * The clips POSTed to the runner server at `to` as one body (audio.ts packClips): the browser
   * host's way home, as `send` is for frames.
   */
  sendAudio: (to: string) =>
    enqueue(false, async () => {
      const r = await fetch(to, { method: 'POST', body: packClips(await clips()) })
      if (!r.ok) throw new Error(`The runner server refused the sound (${r.status}).`)
    }),
  /** How often render read the wall clock since the worker started (counted, never blocked). */
  clock: async () => ({ date: clock.date, performance: clock.performance }),
  /** Where render's time went (render-time.ts), `reset` starting it again; no Canvas2D check here. */
  profile: async (reset = false): Promise<{ time: RenderTime }> => {
    const time = renderTime()
    if (reset) resetRenderTime()
    return { time }
  },
  /** The source's captions, as it returns them; null without captions(). */
  captions: () =>
    enqueue(
      false,
      async (): Promise<readonly Caption[] | null> =>
        opened().captions ? await (opened().captions as () => Promise<readonly Caption[]>)() : null,
    ),
  /** How a sequential source reached its frames; null for any other. */
  seeks: () =>
    enqueue(false, async () => (manifest.sequential ? (opened() as Seekable).stats() : null)),
  /** The DOM's text at t as the page laid it out (dom.ts `text`); [] without a DOM. */
  text: (t: number) =>
    enqueue(false, async () =>
      manifest.dom === undefined ? [] : (await domCall<{ runs: unknown[] }>({ text: t })).runs,
    ),
  /**
   * The frame at t through the authored camera, composited `over`, as straight RGBA bytes (for
   * diffs, checks and export).
   */
  pixels: (t: number, intent: 'preview' | 'final' = 'final') =>
    enqueue(false, () =>
      authored(async () => {
        const { bytes } = await composite(t, intent)
        return Comlink.transfer(bytes, [bytes.buffer])
      }),
    ),
  /**
   * The frame at t, POSTed to the runner server at `to` (the browser host's way home: one HTTP body
   * instead of base64 over the DevTools protocol). Returns its layers' names, and an hdr10 render's
   * light levels, as the Node host does.
   */
  send: (t: number, intent: 'preview' | 'final', format: GpuOutput | HdrOutput, to: string) =>
    enqueue(false, () =>
      authored(async () => {
        // Timed until the runner server has the frame: its compositor, readback and hand-off.
        const timer = timeFrame()
        const { bytes, layers, light } = await composite(t, intent, format, timer)
        const r = await fetch(to, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer> })
        if (!r.ok) throw new Error(`The runner server refused the frame (${r.status}).`)
        timer.done()
        return { layers, ...(light ? { light } : {}) }
      }),
    ),
  /**
   * checkDeterminism in the browser host, through the authored camera: two orders, same output (an
   * hdr10 render's P010 bytes, whose every frame also passes the peak check).
   */
  check: (times: readonly number[]) =>
    enqueue(false, () =>
      authored(() =>
        checkDeterminism({
          times,
          render: async (t) =>
            (await composite(t, 'final', range === 'hdr10' ? 'p010' : 'rgba')).bytes,
          inspect: opened().inspect
            ? async (t) => (await opened().inspect?.(t)) ?? null
            : undefined,
        }),
      ),
    ),
}

/** The source's audio() as hosts pass it on, a function gain sampled; a throw names audio(). */
const clips = async (): Promise<SampledClip[]> => {
  let made: Awaited<ReturnType<NonNullable<Source['audio']>>>
  try {
    made = (await opened().audio?.()) ?? []
  } catch (error) {
    throw new Error(`audio() failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  return sampleClips(made, manifest.duration)
}

/**
 * Runs `run` through the source's authored camera: the exploration override is lifted for it and
 * put back after. Safe because the queue runs one call at a time.
 */
const authored = async <T>(run: () => Promise<T>): Promise<T> => {
  const camera = opened().camera
  if (!explore || !camera?.override) return run()
  camera.override(null)
  try {
    return await run()
  } finally {
    camera.override(explore)
  }
}

/**
 * The frame at t as bytes: composited on the GPU (straight RGBA, or yuv420p for an mp4); without
 * WebGPU, drawn bottom to top on one canvas, as the preview does, and read back (RGBA only). With
 * its layers' names and `final` (layerInfo).
 */
const composite = async (
  t: number,
  intent: 'preview' | 'final',
  format: GpuOutput | HdrOutput = 'rgba',
  timer?: FrameTimer,
): Promise<{
  bytes: Uint8Array | Uint8ClampedArray
  layers: ReturnType<typeof layerInfo>[]
  light?: LightLevels
}> => {
  const { width, height } = manifest
  const dom = await domAt(t)
  try {
    const frame = await counted(
      () =>
        opened().render(t, {
          width,
          height,
          intent,
          frame: frameAt(t, manifest.fps),
          ...(dom ? { dom } : {}),
        }),
      timer,
    )
    const layers = lightChecked(finalOnly(flattenFrame(frame), intent, t), range)
    const info = layers.map(layerInfo)
    if (range === 'hdr10') {
      if (format !== 'rgb10' && format !== 'p010')
        throw new Error(
          `An hdr10 render comes out as rgb10 or p010, not ${format}: nothing of it is composited in SDR.`,
        )
      const { bytes, light } = await (await hdrFor()).composite(
        layers.map((l) => toGpuLayer(l, width, height)),
        format,
        frameAt(t, manifest.fps),
      )
      return { bytes, layers: info, light }
    }
    if (format === 'rgb10' || format === 'p010')
      throw new Error(`${format} comes from an hdr10 render; this one is SDR.`)
    const c = await compositorFor()
    if (c)
      return {
        bytes: await c.composite(
          layers.map((l) => toGpuLayer(l, width, height)),
          format,
        ),
        layers: info,
      }
    if (format !== 'rgba')
      throw new Error(`${format} is made on the GPU: this browser has no WebGPU.`)
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
    for (const layer of await depthTested(layers, width, height)) {
      const bitmap = await toBitmap(layer, width, height)
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
    }
    return { bytes: ctx.getImageData(0, 0, width, height).data, layers: info }
  } finally {
    dom?.close()
  }
}
export type RunnerApi = typeof api

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { connect?: MessagePort; dom?: MessagePort } | null
  if (data?.connect !== undefined) Comlink.expose(api, data.connect)
  if (data?.dom !== undefined) {
    domPort = data.dom
    domPort.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; error?: string }
      const w = waiting.get(m.id)
      waiting.delete(m.id)
      if (m.error !== undefined) w?.fail(new Error(m.error))
      else w?.ok(m)
    }
  }
})
