// A third Child adapter, for tests: it runs in this process, with no build, host process or
// browser. The contract suite (node/contract.it.ts) holds it to what the Node and browser hosts
// do; tests of logic that only needs a Child (export, finishing, check, review, delivery) use it.
import {
  type Caption,
  frameAt,
  type Hdr10,
  type Json,
  type Layer,
  type Manifest,
  type Matrices,
  type Pick,
  type SampledClip,
} from '@shaderera/core'
import {
  CODE_LIGHT,
  finalOnly,
  type GpuOutput,
  type HdrOutput,
  lightReference,
  p010Fits,
  p010Reference,
  peakCode,
  rgb10Reference,
  yuvFits,
} from '@shaderera/core/host'
import { tempDir } from '../../fixtures/temp.ts'
import type { TextRun } from '../../review/measure.ts'
import type { Child, ClockReads, HostIdentity, Rendered } from '../child.ts'
import type { Fonts, HostProfile } from '../host.ts'
import type { Project } from '../project.ts'

export type MemoryChildOptions = {
  /** The frame size: what every frame must be. */
  size: { width: number; height: number }
  /**
   * The frame at t as straight RGBA, rows from the top, composited already; or that and its
   * layers (a layer with `final: false` fails a final render, as in the hosts). A throw fails the
   * call with its message. Transparent black by default.
   */
  frame?: (t: number, intent: 'preview' | 'final') => Uint8Array | Rendered
  /** What `audio()` gives (sampled, as the hosts give it); null (the default): no `audio()`. */
  clips?: readonly SampledClip[] | null
  /** What `captions()` gives; null (the default): no `captions()`. */
  captions?: readonly Caption[] | null
  /** The source's `inspect`; without it `has.inspect` is false and `inspect` gives null. */
  inspect?: (t: number) => Json
  pick?: (t: number, x: number, y: number) => Pick | null
  /** The source's camera; `override` replaces it until given back with null. */
  camera?: (t: number) => Matrices
  /** The DOM text at t (browser host); [] by default, as in the Node host. */
  text?: (t: number) => TextRun[]
  fonts?: Fonts
  clock?: ClockReads
  /** What `profile()` gives: no renders timed by default. */
  profile?: HostProfile
  /**
   * The host composites on the GPU (decision 0007): `has.deep`, and `has.yuv` where the frame size
   * takes yuv420p (width divisible by 8, even height). True by default; false is the Node host
   * without `webgpu`, which gives RGBA only.
   */
  gpu?: boolean
  /**
   * The source opened in an hdr10 range (decision 0023), with the manifest's `hdr10` and rate:
   * each frame is an SDR layer of the HDR compositor's float64 reference, out as `rgb10` or `p010`
   * with its light levels (`has.p010`); an SDR format is refused, and so is a frame past the peak.
   */
  hdr?: { hdr10: Hdr10; fps: number }
  identity?: HostIdentity
}

/** The Child of a source made of a function of t and lists: no process, no browser, no build. */
export const memoryChild = (o: MemoryChildOptions): Child => {
  const { width, height } = o.size
  const gpu = o.gpu ?? true
  const hdr = o.hdr
  let closed = false
  let override: Matrices | null = null
  const open = () => {
    if (closed) throw new Error('The source process has exited.')
  }
  const call =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      open()
      return await f(...a)
    }
  return {
    has: {
      inspect: o.inspect !== undefined,
      pick: o.pick !== undefined,
      camera: o.camera !== undefined,
      sequential: false,
      yuv: !hdr && gpu && yuvFits(width, height),
      deep: !hdr && gpu,
      p010: !!hdr,
    },
    render: call(
      (t: number, intent: 'preview' | 'final', format: GpuOutput | HdrOutput = 'rgba') => {
        const made = o.frame?.(t, intent) ?? new Uint8Array(width * height * 4)
        const { pixels, layers } =
          made instanceof Uint8Array ? { pixels: made, layers: [{ name: 'frame' }] } : made
        finalOnly(layers as unknown as Layer[], intent, t)
        if (pixels.length !== width * height * 4)
          throw new Error(
            `The frame at t=${t} is ${pixels.length} bytes, not ${width}×${height}×4.`,
          )
        if (hdr) {
          if (format !== 'rgb10' && format !== 'p010')
            throw new Error(
              `An hdr10 render comes out as rgb10 or p010, not ${format}: nothing of it is composited in SDR.`,
            )
          if (format === 'p010' && !p010Fits(width, height))
            throw new Error(`p010 needs an even width and height, not ${width}x${height}.`)
          const frame = frameAt(t, hdr.fps)
          const codes = rgb10Reference(
            [{ data: new Uint8Array(pixels), alpha: 'straight' }],
            width,
            height,
            hdr.hdr10,
            frame,
          )
          const light = lightReference(codes)
          const { peak } = hdr.hdr10.mastering
          if (light.maxCll > (CODE_LIGHT[peakCode(peak)] as number))
            throw new Error(
              `Frame ${frame} reaches ${Math.round(light.maxCll)} cd/m², above the mastering display's peak of ${peak} cd/m² (hdr10.mastering.peak).`,
            )
          const out = format === 'p010' ? p010Reference(codes, width, height) : codes
          return {
            pixels: new Uint8Array(out.buffer),
            layers: layers.map((l) => ({ ...l })),
            light,
          }
        }
        if (format === 'rgb10' || format === 'p010')
          throw new Error(`${format} comes from an hdr10 render; this one is SDR.`)
        if (format !== 'rgba' && !gpu)
          throw new Error(`${format} is made on the GPU: this project has no \`webgpu\` (Dawn).`)
        const out =
          format === 'yuv420p'
            ? toYuv420p(pixels, width, height)
            : format === 'rgba64'
              ? toRgba64(pixels)
              : new Uint8Array(pixels)
        return { pixels: out, layers: layers.map((l) => ({ ...l })) }
      },
    ),
    inspect: call((t: number) => o.inspect?.(t) ?? null),
    pick: call((t: number, x: number, y: number) => o.pick?.(t, x, y) ?? null),
    camera: call((t: number) => override ?? o.camera?.(t) ?? null),
    override: call((m: Matrices | null) => {
      override = o.camera ? m : null
    }),
    audio: call(() => o.clips ?? null),
    captions: call(() => o.captions ?? null),
    fonts: call(() => o.fonts ?? { fonts: [], failures: [] }),
    identity: call(
      () => o.identity ?? { host: 'node' as const, node: process.version, adapter: 'in-memory' },
    ),
    clock: call(() => o.clock ?? { date: 0, performance: 0 }),
    profile: call(
      () => o.profile ?? { time: { renders: 0, renderMs: 0, videoMs: 0, composeMs: 0 } },
    ),
    seeks: call(() => null),
    text: call((t: number) => o.text?.(t) ?? []),
    close: async () => {
      closed = true
    },
  }
}

/**
 * A project for a memory child: this manifest (a 1 s, 10 fps, 64×36 film by default) and a new
 * empty folder as its root, where `out/` and clip files go.
 */
export const memoryProject = (manifest: Partial<Manifest> = {}): Project => ({
  root: tempDir('memory'),
  manifest: {
    entry: './src/composition.ts',
    fps: 10,
    duration: 1,
    width: 64,
    height: 36,
    ...manifest,
  },
})

/**
 * fixtures/mcp's film as a frame function: an opaque red 8×8 box at x = 20 - 10t, y = 10, over
 * transparent black.
 */
export const boxFrame =
  (width: number, height: number) =>
  (t: number): Rendered => {
    const pixels = new Uint8Array(width * height * 4)
    const left = Math.round(20 - 10 * t)
    for (let y = 10; y < Math.min(18, height); y++)
      for (let x = Math.max(left, 0); x < Math.min(left + 8, width); x++)
        pixels.set([255, 0, 0, 255], (y * width + x) * 4)
    return { pixels, layers: [{ name: 'box' }] }
  }

/** Straight RGBA at 16 bits a channel, little-endian: what `rgba64` gives for 8-bit layers. */
const toRgba64 = (rgba: Uint8Array) => {
  const deep = new Uint16Array(rgba.length)
  for (let i = 0; i < rgba.length; i++) deep[i] = (rgba[i] as number) * 257
  return new Uint8Array(deep.buffer)
}

/**
 * Straight RGBA matted over black as Y'CbCr 4:2:0, BT.709 limited range, chroma sited left with a
 * [1 2 1] / 4 filter over the two rows' mean: the GPU compositor's `yuv` pass (core
 * compositor.ts), on the CPU.
 */
export const toYuv420p = (rgba: Uint8Array, width: number, height: number): Uint8Array => {
  if (!yuvFits(width, height))
    throw new Error(
      `yuv420p needs a width divisible by 8 and an even height, not ${width}x${height}.`,
    )
  const matte = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4
    const a = (rgba[i + 3] as number) / 255
    return [0, 1, 2].map((k) => ((rgba[i + k] as number) / 255) * a) as [number, number, number]
  }
  const code = (base: number, scale: number, c: number[], w: number[]) =>
    Math.min(
      255,
      Math.max(0, Math.round(base + scale * c.reduce((s, v, k) => s + v * (w[k] as number), 0))),
    )
  const plane = width * height
  const out = new Uint8Array(plane * 1.5)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      out[y * width + x] = code(16, 219, matte(x, y), [0.2126, 0.7152, 0.0722])
  for (let cy = 0; cy < height / 2; cy++)
    for (let cx = 0; cx < width / 2; cx++) {
      const column = (x: number) => {
        const a = matte(Math.max(x, 0), 2 * cy)
        const b = matte(Math.max(x, 0), 2 * cy + 1)
        return a.map((v, k) => (v + (b[k] as number)) / 2)
      }
      const [l, m, r] = [column(2 * cx - 1), column(2 * cx), column(2 * cx + 1)]
      const c = m.map((v, k) => (l[k] as number) * 0.25 + v * 0.5 + (r[k] as number) * 0.25)
      const at = cy * (width / 2) + cx
      out[plane + at] = code(128, 224, c, [-0.114572, -0.385428, 0.5])
      out[plane + plane / 4 + at] = code(128, 224, c, [0.5, -0.454153, -0.045847])
    }
  return out
}
