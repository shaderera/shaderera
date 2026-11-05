// Structure between two frames of one size: SSIM and an edge score, on the whole frame and over
// masks. What `still --compare-file <image>` reports beside PSNR and ΔE. It measures and never
// judges (decisions 0011 and 0032): no number here passes or fails anything.
import { matte } from '@shaderera/core/host'

/**
 * How SSIM is measured, as the report names it: Wang, Bovik, Sheikh and Simoncelli 2004, on luma,
 * with an 11-tap Gaussian window of σ 1.5 and the paper's K1 and K2. The same as scikit-image's
 * `structural_similarity(gaussian_weights=True, sigma=1.5, use_sample_covariance=False,
 * data_range=255)`: the window is reflected at the frame's edge, and the whole frame's mean
 * leaves out a border of 5 pixels.
 */
export const SSIM = {
  method: 'Wang et al. 2004',
  luma: 'BT.709',
  window: 'gaussian',
  size: 11,
  sigma: 1.5,
  k1: 0.01,
  k2: 0.03,
  range: 255,
  border: 5,
} as const

/** How the edge score is measured, as the report names it. */
export const EDGES = {
  operator: 'sobel',
  on: 'luma',
  /** Σ 2·min(film, reference) / Σ (film + reference) of the gradient magnitudes. */
  agreement: 'shared magnitude',
} as const

/** Luma (BT.709 weights on the sRGB values, 0–255, unrounded) of RGBA matted over black. */
export const luma = (px: Uint8Array | Uint8ClampedArray): Float64Array => {
  const x = matte(px)
  const out = new Float64Array(x.length / 4)
  for (let i = 0; i < out.length; i++)
    out[i] =
      0.2126 * (x[i * 4] as number) +
      0.7152 * (x[i * 4 + 1] as number) +
      0.0722 * (x[i * 4 + 2] as number)
  return out
}

/** Index i on an axis of n samples, reflected at both ends (d c b a | a b c d | d c b a). */
const reflect = (i: number, n: number) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i)

/** The Gaussian taps, σ 1.5 over a radius of 5 (scipy's truncate 3.5), summing to 1. */
const TAPS = (() => {
  const r = (SSIM.size - 1) / 2
  const k = Array.from({ length: SSIM.size }, (_, i) =>
    Math.exp(-0.5 * ((i - r) / SSIM.sigma) ** 2),
  )
  const sum = k.reduce((a, b) => a + b, 0)
  return Float64Array.from(k, (v) => v / sum)
})()

/** A plane blurred by TAPS along x, then y, reflected at the edges. */
const blur = (src: Float64Array, w: number, h: number): Float64Array => {
  const r = (SSIM.size - 1) / 2
  const mid = new Float64Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let k = -r; k <= r; k++)
        s += (TAPS[k + r] as number) * (src[y * w + reflect(x + k, w)] as number)
      mid[y * w + x] = s
    }
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let k = -r; k <= r; k++)
        s += (TAPS[k + r] as number) * (mid[reflect(y + k, h) * w + x] as number)
      out[y * w + x] = s
    }
  return out
}

/**
 * The SSIM map of two luma planes of `w`×`h` (see SSIM), one value a pixel, 1 where the window
 * around it is the same in both; and its mean over the frame less a border of 5 pixels. Throws
 * when a side is shorter than the window.
 */
export const ssim = (
  a: Float64Array,
  b: Float64Array,
  w: number,
  h: number,
): { map: Float64Array; mean: number } => {
  if (a.length !== w * h || b.length !== w * h) throw new Error('ssim needs two planes of w × h.')
  if (w < SSIM.size || h < SSIM.size)
    throw new Error(
      `SSIM needs at least ${SSIM.size}×${SSIM.size} pixels, its window: this is ${w}×${h}.`,
    )
  const n = w * h
  const aa = new Float64Array(n)
  const bb = new Float64Array(n)
  const ab = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    aa[i] = x * x
    bb[i] = y * y
    ab[i] = x * y
  }
  const ux = blur(a, w, h)
  const uy = blur(b, w, h)
  const uxx = blur(aa, w, h)
  const uyy = blur(bb, w, h)
  const uxy = blur(ab, w, h)
  const c1 = (SSIM.k1 * SSIM.range) ** 2
  const c2 = (SSIM.k2 * SSIM.range) ** 2
  const map = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const mx = ux[i] as number
    const my = uy[i] as number
    const vx = (uxx[i] as number) - mx * mx
    const vy = (uyy[i] as number) - my * my
    const vxy = (uxy[i] as number) - mx * my
    map[i] = ((2 * mx * my + c1) * (2 * vxy + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2))
  }
  const p = SSIM.border
  let sum = 0
  for (let y = p; y < h - p; y++) for (let x = p; x < w - p; x++) sum += map[y * w + x] as number
  return { map, mean: sum / ((w - 2 * p) * (h - 2 * p)) }
}

/**
 * The Sobel gradient magnitude of a luma plane, in levels: hypot of the 3×3 derivative across and
 * down (−1 0 1, smoothed 1 2 1), reflected at the edges as scipy's `ndimage.sobel`.
 */
export const sobel = (p: Float64Array, w: number, h: number): Float64Array => {
  const out = new Float64Array(w * h)
  const at = (x: number, y: number) => p[reflect(y, h) * w + reflect(x, w)] as number
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) -
        at(x - 1, y - 1) +
        2 * (at(x + 1, y) - at(x - 1, y)) +
        at(x + 1, y + 1) -
        at(x - 1, y + 1)
      const gy =
        at(x - 1, y + 1) -
        at(x - 1, y - 1) +
        2 * (at(x, y + 1) - at(x, y - 1)) +
        at(x + 1, y + 1) -
        at(x + 1, y - 1)
      out[y * w + x] = Math.hypot(gx, gy)
    }
  return out
}

/**
 * Coverage 0–255 over a rectangle of a frame: the pixels a score is weighted by. `x`, `y` are
 * its top-left corner in the frame, and `coverage` is `width × height` bytes, rows `width` apart.
 */
export type Mask = { x: number; y: number; width: number; height: number; coverage: Uint8Array }

/** The whole frame as a mask, every pixel counting fully. */
export const everywhere = (width: number, height: number): Mask => ({
  x: 0,
  y: 0,
  width,
  height,
  coverage: new Uint8Array(width * height).fill(255),
})

/** Calls `each(i, weight)` for every pixel of `frameWidth`-wide planes that the mask covers. */
const covered = (m: Mask, frameWidth: number, each: (i: number, weight: number) => void) => {
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) {
      const weight = m.coverage[y * m.width + x] as number
      if (weight > 0) each((m.y + y) * frameWidth + m.x + x, weight)
    }
}

/** The mean of a plane weighted by the mask's coverage; `null` when it covers nothing. */
export const maskedMean = (plane: Float64Array, frameWidth: number, m: Mask): number | null => {
  let sum = 0
  let weights = 0
  covered(m, frameWidth, (i, weight) => {
    sum += weight * (plane[i] as number)
    weights += weight
  })
  return weights === 0 ? null : sum / weights
}

/** The largest value of a plane where the mask covers anything; `null` when it covers nothing. */
export const maskedMax = (plane: Float64Array, frameWidth: number, m: Mask): number | null => {
  let max = Number.NEGATIVE_INFINITY
  covered(m, frameWidth, (i) => {
    max = Math.max(max, plane[i] as number)
  })
  return max === Number.NEGATIVE_INFINITY ? null : max
}

/** The edge score over a mask: how much of the two sides' gradient magnitude both have. */
export type Edges = {
  /**
   * Σ 2·min(film, reference) / Σ (film + reference), weighted by coverage: 1 when the magnitudes
   * are the same, 0 when no edge of one is where the other has one. `null` when neither side has
   * an edge there.
   */
  agreement: number | null
  /** The film's mean magnitude, in levels. */
  film: number
  /** The reference's mean magnitude, in levels. */
  reference: number
}

/** The edge score of two Sobel magnitude planes over a mask (see Edges). */
export const edges = (
  film: Float64Array,
  reference: Float64Array,
  frameWidth: number,
  m: Mask,
): Edges => {
  let shared = 0
  let both = 0
  let a = 0
  let b = 0
  let weights = 0
  covered(m, frameWidth, (i, weight) => {
    const x = film[i] as number
    const y = reference[i] as number
    shared += weight * 2 * Math.min(x, y)
    both += weight * (x + y)
    a += weight * x
    b += weight * y
    weights += weight
  })
  return {
    // Below this both sides are flat up to float rounding.
    agreement: both <= 1e-9 ? null : shared / both,
    film: weights === 0 ? 0 : a / weights,
    reference: weights === 0 ? 0 : b / weights,
  }
}

/** matplotlib's inferno at 0, 0.25, 0.5, 0.75 and 1, between which the heat map is linear. */
const INFERNO = [
  [0, 0, 4],
  [87, 16, 110],
  [188, 55, 84],
  [249, 142, 9],
  [252, 255, 164],
] as const

/**
 * The SSIM map as opaque RGBA: 1 − SSIM on inferno's ramp, black where the structure is the same
 * and pale yellow at SSIM 0 or below. A fixed scale, so two maps read the same way.
 */
export const heatMap = (map: Float64Array): Uint8Array => {
  const out = new Uint8Array(map.length * 4)
  const last = INFERNO.length - 1
  for (let i = 0; i < map.length; i++) {
    const v = Math.min(1, Math.max(0, 1 - (map[i] as number))) * last
    const k = Math.min(last - 1, Math.floor(v))
    const f = v - k
    const lo = INFERNO[k] as readonly number[]
    const hi = INFERNO[k + 1] as readonly number[]
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = Math.round((lo[c] as number) + ((hi[c] as number) - (lo[c] as number)) * f)
    out[i * 4 + 3] = 255
  }
  return out
}
