// Grading curves from control points, baked into tables. RGB curves (a master and one per channel)
// bake into a color-lut 1D LUT, which lut1d and applyLut apply. Hue curves (hue vs saturation,
// hue vs hue) bake into a table over hue, which curves.wgsl.ts applies in a shader and
// applyHueCurves applies on the CPU with the same values. Every curve is a monotone cubic through
// its points (Fritsch–Butland tangents, as PCHIP has inside; each end piece's own slope at the
// ends): exact at them, never past them, flat beyond the ends.

import type { Lut } from './lut.ts'

type Rgb = readonly [number, number, number]

/** A control point, `[x, y]`: in and out for an RGB curve; a hue in degrees and its value for a hue curve. */
export type CurvePoint = readonly [number, number]

// Fritsch–Carlson's tangent at a point between the slopes a and b of pieces ha and hb wide: 0 at
// a peak, a valley or a flat, else their weighted harmonic mean (Fritsch and Butland's weights),
// which keeps each piece between its two points.
const tangent = (a: number, b: number, ha: number, hb: number) =>
  a * b <= 0 ? 0 : (3 * (ha + hb)) / ((2 * hb + ha) / a + (hb + 2 * ha) / b)

// The cubic Hermite curve through xs and ys with tangents ms, flat beyond the first and last x.
const hermite = (xs: number[], ys: number[], ms: number[]) => (x: number) => {
  const n = xs.length
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0
  if (x >= (xs[n - 1] ?? 0)) return ys[n - 1] ?? 0
  let k = 0
  while (x > (xs[k + 1] ?? 0)) k++
  const [x0, x1, y0, y1] = [xs[k] ?? 0, xs[k + 1] ?? 0, ys[k] ?? 0, ys[k + 1] ?? 0]
  const h = x1 - x0
  const t = (x - x0) / h
  const t2 = t * t
  const t3 = t2 * t
  return (
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * h * (ms[k] ?? 0) +
    (3 * t2 - 2 * t3) * y1 +
    (t3 - t2) * h * (ms[k + 1] ?? 0)
  )
}

const sorted = (points: readonly CurvePoint[], what: string) => {
  const p = [...points].sort((a, b) => a[0] - b[0])
  p.forEach(([x], i) => {
    if (i > 0 && x === p[i - 1]?.[0]) throw new Error(`${what}: two points at ${x}`)
  })
  return [p.map((q) => q[0]), p.map((q) => q[1])] as const
}

const slopes = (xs: number[], ys: number[]) =>
  xs.slice(1).map((x, k) => ((ys[k + 1] ?? 0) - (ys[k] ?? 0)) / (x - (xs[k] ?? 0)))

/**
 * The monotone cubic through `points`, any order: exact at each one, never past the two either
 * side, flat beyond the first and the last. No points is the identity; one is a constant.
 */
export const spline = (points: readonly CurvePoint[]): ((x: number) => number) => {
  if (points.length === 0) return (x) => x
  const [xs, ys] = sorted(points, 'spline')
  const d = slopes(xs, ys)
  const h = xs.slice(1).map((x, k) => x - (xs[k] ?? 0))
  // The end tangents are the end pieces' slopes, so two points make a straight line.
  const ms = xs.map((_, k) =>
    k === 0 || k === xs.length - 1
      ? (d[Math.min(k, d.length - 1)] ?? 0)
      : tangent(d[k - 1] ?? 0, d[k] ?? 0, h[k - 1] ?? 0, h[k] ?? 0),
  )
  return hermite(xs, ys, ms)
}

/**
 * The monotone cubic through `points` at hues in degrees, around the circle: the last point joins
 * the first across 360°, with the same value and slope at 0 and 360. One point is a constant.
 */
export const hueSpline = (points: readonly CurvePoint[]): ((hue: number) => number) => {
  const [xs, ys] = sorted(
    points.map(([x, y]) => [((x % 360) + 360) % 360, y] as const),
    'hueSpline',
  )
  const n = xs.length
  if (n < 2) return () => ys[0] ?? 0
  // The points, with the last one before 0 and the first one after 360.
  const wx = [(xs[n - 1] ?? 0) - 360, ...xs, (xs[0] ?? 0) + 360]
  const wy = [ys[n - 1] ?? 0, ...ys, ys[0] ?? 0]
  const d = slopes(wx, wy)
  const h = wx.slice(1).map((x, k) => x - (wx[k] ?? 0))
  // Each point's tangent from its neighbours around the circle; the two copies take theirs.
  const inner = xs.map((_, k) => tangent(d[k] ?? 0, d[k + 1] ?? 0, h[k] ?? 0, h[k + 1] ?? 0))
  const f = hermite(wx, wy, [inner[n - 1] ?? 0, ...inner, inner[0] ?? 0])
  return (hue) => f(((hue % 360) + 360) % 360)
}

/** Curves per channel: `master` first, then each channel's own. Each one left out is the identity. */
export type RgbCurves = {
  readonly master?: readonly CurvePoint[]
  readonly red?: readonly CurvePoint[]
  readonly green?: readonly CurvePoint[]
  readonly blue?: readonly CurvePoint[]
}

/**
 * The RGB curves baked into a 1D LUT over 0–1 of `size` entries: each channel through the master,
 * then through its own curve. `applyLut` and `lut1d` (color-lut) apply it; `lutTexture` puts it
 * on the GPU; `writeCube` writes it as a file.
 */
export const curvesLut = (curves: RgbCurves, size = 1024): Lut => {
  if (!Number.isInteger(size) || size < 2)
    throw new Error(`curvesLut: size must be 2 or more, not ${size}`)
  const master = spline(curves.master ?? [])
  const channel = [curves.red, curves.green, curves.blue].map((p) => spline(p ?? []))
  const table = new Float64Array(size * 3)
  for (let i = 0; i < size; i++) {
    const m = master(i / (size - 1))
    for (let c = 0; c < 3; c++) table[i * 3 + c] = channel[c]?.(m) ?? m
  }
  return { dimensions: 1, size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], table }
}

/**
 * Curves over hue, the points' x a hue in degrees. `hueVsSat`: a saturation factor at each hue,
 * 1 unchanged, 0 grey, 2 double. `hueVsHue`: a hue offset in degrees, 0 unchanged.
 */
export type HueCurves = {
  readonly hueVsSat?: readonly CurvePoint[]
  readonly hueVsHue?: readonly CurvePoint[]
}

/**
 * The hue curves baked into a table of `size` entries, evenly around 360° from 0: a 1D LUT whose
 * entries are [saturation factor, hue offset in degrees, 0]. `lutTexture` (color-lut) puts it on
 * the GPU for `applyHueCurves` in curves.wgsl.ts; on the CPU, `applyHueCurves` here. Not for
 * `applyLut`: hue wraps, and a LUT clamps.
 */
export const hueCurvesLut = (curves: HueCurves, size = 256): Lut => {
  if (!Number.isInteger(size) || size < 2)
    throw new Error(`hueCurvesLut: size must be 2 or more, not ${size}`)
  const sat = curves.hueVsSat?.length ? hueSpline(curves.hueVsSat) : () => 1
  const hue = hueSpline(curves.hueVsHue ?? [])
  const table = new Float64Array(size * 3)
  for (let i = 0; i < size; i++) {
    const h = (i * 360) / size
    table[i * 3] = sat(h)
    table[i * 3 + 1] = hue(h)
  }
  return { dimensions: 1, size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], table }
}

/** The HSV hue of a colour in degrees, 0–360; 0 for a grey, which has none. */
export const hueOf = ([r, g, b]: Rgb) => {
  const hi = Math.max(r, g, b)
  const chroma = hi - Math.min(r, g, b)
  if (chroma <= 0) return 0
  const h = hi === r ? (g - b) / chroma : hi === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
  return (((h * 60) % 360) + 360) % 360
}

/**
 * A colour through the hue curves, both read at its own HSV hue: the hue turned by the offset,
 * keeping the largest and smallest channel (HSV value and saturation), then the saturation scaled
 * around Rec.709 luma, which that keeps. Turning a hue moves luma.
 */
export const applyHueCurves = (lut: Lut, rgb: Rgb): [number, number, number] => {
  const n = lut.size
  const p = (hueOf(rgb) / 360) * n
  const i = Math.floor(p) % n
  const f = p - Math.floor(p)
  const entry = (c: number) =>
    (lut.table[i * 3 + c] ?? 0) * (1 - f) + (lut.table[((i + 1) % n) * 3 + c] ?? 0) * f
  const [sat, offset] = [entry(0), entry(1)]
  const lo = Math.min(...rgb)
  const chroma = Math.max(...rgb) - lo
  // The hue's place on the six sides of the HSV hexagon, 0–6, to each channel's share of chroma.
  const h = ((((hueOf(rgb) + offset) / 60) % 6) + 6) % 6
  const share = [Math.abs(h - 3) - 1, 2 - Math.abs(h - 2), 2 - Math.abs(h - 4)]
  const turned = share.map((s) => lo + chroma * Math.min(Math.max(s, 0), 1))
  const luma = 0.2126 * (turned[0] ?? 0) + 0.7152 * (turned[1] ?? 0) + 0.0722 * (turned[2] ?? 0)
  return turned.map((c) => luma + sat * (c - luma)) as [number, number, number]
}
