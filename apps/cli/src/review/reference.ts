// A film measured against a reference clip: what `still --compare-file` reports. It measures and
// never judges (decisions 0011 and 0032): no number here passes or fails anything.
import { matte } from '@shaderera/core/host'

/**
 * How much each sample changed from the one before: the mean over pixels of |ΔR|, |ΔG| and |ΔB|,
 * in levels (0–255), on frames matted over black. The first sample has none before it: `null`.
 * It shows timing apart from colour.
 */
export type Curve = readonly (number | null)[]

/** The mean change between two RGBA frames of one size, in levels: 0 when they are the same. */
export const meanChange = (
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
): number => {
  if (a.length !== b.length) throw new Error('meanChange needs two frames of one size.')
  const x = matte(a)
  const y = matte(b)
  let sum = 0
  for (let i = 0; i < x.length; i += 4)
    sum +=
      Math.abs((x[i] as number) - (y[i] as number)) +
      Math.abs((x[i + 1] as number) - (y[i + 1] as number)) +
      Math.abs((x[i + 2] as number) - (y[i + 2] as number))
  return x.length === 0 ? 0 : sum / ((x.length / 4) * 3)
}

/** The activity curve of frames in time order (meanChange from each one's previous). */
export const activity = (frames: readonly (Uint8Array | Uint8ClampedArray)[]): Curve =>
  frames.map((f, i) => (i === 0 ? null : meanChange(frames[i - 1] as Uint8Array, f)))

/** Where a curve moves: the first and last sample that changes more than `floor`, and the peak. */
export type Window = { first: number; last: number; peak: { index: number; change: number } }

/**
 * The motion window of a curve: the first and last sample whose change is above `floor` (levels),
 * and the largest change. `null` when nothing is above it. A rendered film is still at exactly 0;
 * a decoded clip has codec noise, which `floor` can name.
 */
export const motionWindow = (curve: Curve, floor = 0): Window | null => {
  let first = -1
  let last = -1
  let peak = { index: -1, change: -1 }
  curve.forEach((c, i) => {
    if (c === null) return
    if (c > floor) {
      if (first < 0) first = i
      last = i
    }
    if (c > peak.change) peak = { index: i, change: c }
  })
  return first < 0 ? null : { first, last, peak }
}

/** One shift tried: the Pearson correlation of the curves over the samples both have. */
export type Score = { shift: number; correlation: number | null; overlap: number }

export type Alignment = {
  /** The shift with the highest correlation, in samples; `null` when none could be measured. */
  shift: number | null
  correlation: number | null
  /** Every shift tried, from -maxShift to maxShift. */
  scores: Score[]
}

/** Pearson's correlation of two equal-length lists; `null` when either does not vary. */
const pearson = (x: readonly number[], y: readonly number[]): number | null => {
  const n = x.length
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += x[i] as number
    my += y[i] as number
  }
  mx /= n
  my /= n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx
    const dy = (y[i] as number) - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  // Below this a curve is flat up to float rounding.
  if (sxx <= 1e-12 || syy <= 1e-12) return null
  return sxy / Math.sqrt(sxx * syy)
}

/**
 * The shift that best aligns two activity curves. `reference[j]` is sampled at the film's sample
 * `j - lead`: the reference may be read `lead` samples before the film's first and as many after
 * its last, so a shift keeps its overlap. Shift `k` pairs the film's sample `i` with the
 * reference's `i + k`: a positive shift means the reference moves later. A shift is measured only
 * where at least half the film's samples (and 3) have a pair; the highest correlation wins, and a
 * tie goes to the smaller shift, then the earlier one.
 */
export const align = (film: Curve, reference: Curve, maxShift: number, lead = 0): Alignment => {
  if (!(Number.isInteger(maxShift) && maxShift >= 0))
    throw new Error(`The largest shift is a whole number of samples, 0 or more, not ${maxShift}.`)
  const least = Math.max(3, Math.ceil(film.length / 2))
  const scores: Score[] = []
  let best: Score | undefined
  for (let k = -maxShift; k <= maxShift; k++) {
    const x: number[] = []
    const y: number[] = []
    film.forEach((f, i) => {
      const r = reference[i + k + lead]
      if (f === null || r === null || r === undefined) return
      x.push(f)
      y.push(r)
    })
    const correlation = x.length >= least ? pearson(x, y) : null
    const score = { shift: k, correlation, overlap: x.length }
    scores.push(score)
    if (correlation === null) continue
    const better =
      !best ||
      correlation > (best.correlation as number) + 1e-12 ||
      (Math.abs(correlation - (best.correlation as number)) <= 1e-12 &&
        Math.abs(k) < Math.abs(best.shift))
    if (better) best = score
  }
  return { shift: best?.shift ?? null, correlation: best?.correlation ?? null, scores }
}

/** The filter scaleFrame uses, named in the report. */
export const FILTER = 'triangle'

/**
 * An RGBA frame matted over black and scaled to `w`×`h` with one separable triangle filter
 * (bilinear, widened when shrinking so every source pixel counts, as Pillow's BILINEAR). The same
 * sizes always give the same weights, so every frame of a clip is scaled the same way.
 */
export const scaleFrame = (
  px: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  w: number,
  h: number,
): Uint8Array => {
  const src = matte(px)
  if (w === width && h === height) return Uint8Array.from(src)
  const across = weights(width, w)
  const down = weights(height, h)
  // Rows first, into floats, then columns.
  const mid = new Float64Array(w * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < w; x++) {
      const { start, k } = across[x] as Taps
      let r = 0
      let g = 0
      let b = 0
      for (let i = 0; i < k.length; i++) {
        const at = (y * width + start + i) * 4
        const wt = k[i] as number
        r += (src[at] as number) * wt
        g += (src[at + 1] as number) * wt
        b += (src[at + 2] as number) * wt
      }
      const o = (y * w + x) * 3
      mid[o] = r
      mid[o + 1] = g
      mid[o + 2] = b
    }
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const { start, k } = down[y] as Taps
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let i = 0; i < k.length; i++) {
        const at = ((start + i) * w + x) * 3
        const wt = k[i] as number
        r += (mid[at] as number) * wt
        g += (mid[at + 1] as number) * wt
        b += (mid[at + 2] as number) * wt
      }
      const o = (y * w + x) * 4
      out[o] = Math.min(255, Math.max(0, Math.round(r)))
      out[o + 1] = Math.min(255, Math.max(0, Math.round(g)))
      out[o + 2] = Math.min(255, Math.max(0, Math.round(b)))
      out[o + 3] = 255
    }
  }
  return out
}

type Taps = { start: number; k: number[] }

/** The triangle filter's taps for each of `to` samples from `from`, each summing to 1. */
const weights = (from: number, to: number): Taps[] => {
  const scale = from / to
  const support = Math.max(1, scale)
  return Array.from({ length: to }, (_, o) => {
    const centre = (o + 0.5) * scale
    const start = Math.max(0, Math.floor(centre - support))
    const end = Math.min(from, Math.ceil(centre + support))
    const k: number[] = []
    let sum = 0
    for (let i = start; i < end; i++) {
      const v = Math.max(0, 1 - Math.abs((i + 0.5 - centre) / support))
      k.push(v)
      sum += v
    }
    return { start, k: k.map((v) => v / sum) }
  })
}

/**
 * The difference of two RGBA frames of one size, as an editor's Difference blend shows it:
 * |a − b| per channel on frames matted over black, opaque. Black where they match.
 */
export const difference = (
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
): Uint8Array => {
  const x = matte(a)
  const y = matte(b)
  const out = new Uint8Array(x.length)
  for (let i = 0; i < x.length; i += 4) {
    out[i] = Math.abs((x[i] as number) - (y[i] as number))
    out[i + 1] = Math.abs((x[i + 1] as number) - (y[i + 1] as number))
    out[i + 2] = Math.abs((x[i + 2] as number) - (y[i + 2] as number))
    out[i + 3] = 255
  }
  return out
}

/** RGBA frames of one size side by side, the first on the left: one frame as wide as all. */
export const row = (
  frames: readonly (Uint8Array | Uint8ClampedArray)[],
  width: number,
  height: number,
): Uint8Array => {
  const line = width * 4
  const out = new Uint8Array(line * frames.length * height)
  for (let y = 0; y < height; y++)
    frames.forEach((f, i) => {
      out.set(f.subarray(y * line, (y + 1) * line), (y * frames.length + i) * line)
    })
  return out
}

/** The step between evenly spaced times (within a microsecond), else `null`. */
export const stepOf = (times: readonly number[]): number | null => {
  if (times.length < 2) return null
  const step = ((times.at(-1) as number) - (times[0] as number)) / (times.length - 1)
  if (!(step > 0)) return null
  return times.every((t, i) => Math.abs(t - ((times[0] as number) + i * step)) <= 1e-6)
    ? step
    : null
}
