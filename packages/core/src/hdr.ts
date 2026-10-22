/*
 * HDR10's numbers (docs/adr/0023), shared by the HDR compositor (hdr-compositor.ts) and its float64
 * reference: PQ (SMPTE ST 2084), BT.709 to BT.2020 primaries (BT.2087), the 10-bit R'G'B' codes,
 * P010 in BT.2020 non-constant luminance (BT.2100), and the light levels (CTA-861.3).
 */
import { GRAPHICS_WHITE } from './manifest.ts'
import type { Hdr10, Light } from './protocol.ts'

/** PQ's constants (SMPTE ST 2084, BT.2100 Table 4). */
export const PQ = {
  m1: 2610 / 16384,
  m2: (2523 / 4096) * 128,
  c1: 3424 / 4096,
  c2: (2413 / 4096) * 32,
  c3: (2392 / 4096) * 32,
} as const
/** PQ's 1.0, in cd/m². */
export const PQ_PEAK = 10000
/** BT.2100's FP16 linear scale: 1.0 is this many cd/m². */
export const LINEAR_WHITE = 203
/** The largest 10-bit code. */
export const TOP = 1023

/** Linear BT.709 to linear BT.2020, row by row (BT.2087, from the two sets of primaries). */
export const BT709_TO_BT2020 = [
  0.627403895934699, 0.329283038377884, 0.043313065687417, 0.069097289358232, 0.919540395075459,
  0.011362315566309, 0.01639143887515, 0.088013307877226, 0.895595253247624,
] as const

/** PQ's inverse EOTF: light (1.0 is 10 000 cd/m²) to a code value from 0 to 1. */
export const pqEncode = (y: number) => {
  if (y <= 0) return 0
  const p = y ** PQ.m1
  return ((PQ.c1 + PQ.c2 * p) / (1 + PQ.c3 * p)) ** PQ.m2
}
/** PQ's EOTF: a code value from 0 to 1 to light (1.0 is 10 000 cd/m²). */
export const pqDecode = (e: number) => {
  if (e <= 0) return 0
  const p = e ** (1 / PQ.m2)
  return (Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p)) ** (1 / PQ.m1)
}
const srgbDecode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** The light of each 10-bit code, in cd/m². */
export const CODE_LIGHT: readonly number[] = Array.from(
  { length: TOP + 1 },
  (_, c) => PQ_PEAK * pqDecode(c / TOP),
)

/** The highest code whose light is at most `peak` cd/m²: no delivered sample may pass it. */
export const peakCode = (peak: number) => {
  let c = TOP
  while (c > 0 && (CODE_LIGHT[c] as number) > peak) c--
  return c
}

/** The light levels of a frame, in cd/m² (CTA-861.3): its brightest max(R,G,B) and its average. */
export type LightLevels = { maxCll: number; maxFall: number }

/**
 * The light levels from a histogram of each pixel's max(R',G',B') code: the brightest code's light,
 * and the mean of every pixel's, summed in float64.
 */
export const levelsOf = (histogram: ArrayLike<number>, pixels: number): LightLevels => {
  let maxCll = 0
  let sum = 0
  for (let c = 0; c <= TOP; c++) {
    const n = histogram[c] as number
    if (n === 0) continue
    maxCll = CODE_LIGHT[c] as number
    sum += n * maxCll
  }
  return { maxCll, maxFall: pixels > 0 ? sum / pixels : 0 }
}

/** The 32-bit hash the dither's noise comes from (PCG), as WGSL computes it on u32. */
export const pcg = (v: number) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}

/** TPDF noise in (-1, 1) codes for a channel of a pixel, seeded by the frame index. */
export const tpdf = (x: number, y: number, channel: number, frame: number) => {
  const k = pcg((pcg((pcg(frame) + y) >>> 0) + x) >>> 0)
  const a = pcg((k + 2 * channel) >>> 0) >>> 8
  const b = pcg((k + 2 * channel + 1) >>> 0) >>> 8
  return (a + b - 2 ** 24) / 2 ** 24
}

/** WGSL's round: half to even. */
const roundEven = (x: number) => {
  const f = Math.floor(x)
  const d = x - f
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1
}

/** A layer as the reference takes it: RGBA bytes (SDR) or floats, and the light they carry. */
export type ReferenceLayer = {
  data: Uint8Array | Float32Array
  alpha: 'premultiplied' | 'straight' | 'opaque'
  light?: Light
}

/** Graphics White in a manifest's `hdr10`: BT.2408's when absent. */
export const whiteOf = (hdr: Hdr10) => hdr.graphicsWhite ?? GRAPHICS_WHITE

/**
 * The float64 reference of the HDR compositor: the layers `over` in linear BT.2020 light, PQ, and
 * 10-bit R'G'B' codes as the `rgb10` output packs them (R in bits 0–9, G 10–19, B 20–29).
 */
export const rgb10Reference = (
  layers: readonly ReferenceLayer[],
  width: number,
  height: number,
  hdr: Hdr10,
  frame: number,
): Uint32Array => {
  const out = new Uint32Array(width * height)
  const top = peakCode(hdr.mastering.peak)
  const white = whiteOf(hdr)
  const m = BT709_TO_BT2020
  for (let i = 0; i < width * height; i++) {
    const acc = [0, 0, 0]
    for (const layer of layers) {
      const bytes = layer.data instanceof Uint8Array
      const c = [0, 1, 2, 3].map((k) => (layer.data[i * 4 + k] as number) / (bytes ? 255 : 1))
      const a = layer.alpha === 'opaque' ? 1 : (c[3] as number)
      if (a <= 0) continue
      let s = c.slice(0, 3).map((v) => (layer.alpha === 'premultiplied' ? v / a : v))
      const transfer = layer.light?.transfer
      if (transfer === 'linear') s = s.map((v) => (v * LINEAR_WHITE) / PQ_PEAK)
      else if (transfer === 'pq') s = s.map((v) => pqDecode(Math.min(Math.max(v, 0), 1)))
      else s = s.map((v) => (srgbDecode(Math.min(Math.max(v, 0), 1)) * white) / PQ_PEAK)
      if ((layer.light?.primaries ?? 'bt709') === 'bt709') {
        const [r, g, b] = s as [number, number, number]
        s = [
          m[0] * r + m[1] * g + m[2] * b,
          m[3] * r + m[4] * g + m[5] * b,
          m[6] * r + m[7] * g + m[8] * b,
        ]
      }
      for (let k = 0; k < 3; k++) acc[k] = (s[k] as number) * a + (acc[k] as number) * (1 - a)
    }
    const x = i % width
    const y = Math.floor(i / width)
    let word = 0
    for (let k = 0; k < 3; k++) {
      const v = pqEncode(Math.min(Math.max(acc[k] as number, 0), 1)) * TOP
      const q = roundEven(v)
      let d = hdr.dither === 'tpdf' && v > 0 ? roundEven(v + tpdf(x, y, k, frame)) : q
      d = Math.min(Math.min(Math.max(d, 0), TOP), Math.max(q, top))
      word += d * 2 ** (10 * k)
    }
    out[i] = word
  }
  return out
}

/** A packed code's R', G' and B' from 0 to 1. */
const unpack = (word: number) => [word & 1023, (word >>> 10) & 1023, (word >>> 20) & 1023]

/**
 * The float64 reference of the P010 output: BT.2020 non-constant luminance from the codes, narrow
 * range (Y' 64–940, C 64–960), 4:2:0 with each chroma sample at an even column and row (top-left,
 * BT.2100 Table 8), [1 2 1]/4 across and down around it, edges clamped. 16-bit little-endian words
 * with the code in the top ten bits: the Y' plane, then Cb and Cr interleaved.
 */
export const p010Reference = (codes: Uint32Array, width: number, height: number): Uint16Array => {
  const KR = 0.2627
  const KB = 0.0593
  const ycc = Array.from(codes, (word) => {
    const [r, g, b] = unpack(word).map((c) => c / TOP) as [number, number, number]
    const y = KR * r + (1 - KR - KB) * g + KB * b
    return [y, (b - y) / (2 * (1 - KB)), (r - y) / (2 * (1 - KR))] as const
  })
  const out = new Uint16Array((width * height * 3) / 2)
  for (let i = 0; i < width * height; i++)
    out[i] = Math.round(64 + 876 * (ycc[i]?.[0] as number)) << 6
  const at = (x: number, y: number) =>
    ycc[
      Math.min(Math.max(y, 0), height - 1) * width + Math.min(Math.max(x, 0), width - 1)
    ] as readonly [number, number, number]
  const W = [1, 2, 1]
  for (let j = 0; j < height / 2; j++)
    for (let i = 0; i < width / 2; i++) {
      let cb = 0
      let cr = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const w = (W[dx + 1] as number) * (W[dy + 1] as number)
          const p = at(2 * i + dx, 2 * j + dy)
          cb += w * p[1]
          cr += w * p[2]
        }
      const k = width * height + 2 * (j * (width / 2) + i)
      out[k] = Math.round(512 + (896 * cb) / 16) << 6
      out[k + 1] = Math.round(512 + (896 * cr) / 16) << 6
    }
  return out
}

/** The float64 reference of the light levels: each pixel's max(R,G,B) in cd/m², from its codes. */
export const lightReference = (codes: Uint32Array): LightLevels => {
  let maxCll = 0
  let sum = 0
  for (const word of codes) {
    const light = PQ_PEAK * pqDecode(Math.max(...unpack(word)) / TOP)
    maxCll = Math.max(maxCll, light)
    sum += light
  }
  return { maxCll, maxFall: codes.length > 0 ? sum / codes.length : 0 }
}
