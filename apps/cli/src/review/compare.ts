// Two renders of the same moment measured against each other: what `still --compare` prints. It
// measures and never judges (decision 0011): no threshold here passes or fails anything.
import { diffPixels } from '@shaderera/core'
import { matte } from '@shaderera/core/host'

export type Comparison = {
  /** Peak signal-to-noise ratio over R, G and B, in dB; Infinity when the frames are the same. */
  psnr: number
  /** The mean colour difference per pixel, CIEDE2000 (1 is about what an eye can just tell). */
  deltaE: number
  /** The largest colour difference of any pixel, CIEDE2000. */
  maxDeltaE: number
  /** Pixels whose R, G, B or A differ at all (diffPixels). */
  differing: number
}

/** sRGB channel (0–255) to linear light, once per value. */
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)

/** sRGB (D65) to CIELAB. */
const lab = (r: number, g: number, b: number): [number, number, number] => {
  const R = LINEAR[r] as number
  const G = LINEAR[g] as number
  const B = LINEAR[b] as number
  const x = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047)
  const y = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B)
  const z = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

const RAD = Math.PI / 180

/** CIEDE2000 between two Lab colours (Sharma, Wu and Dalal, 2005). */
export const deltaE2000 = (
  [L1, a1, b1]: readonly [number, number, number],
  [L2, a2, b2]: readonly [number, number, number],
): number => {
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const C7 = ((C1 + C2) / 2) ** 7
  const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + 25 ** 7)))
  const A1 = (1 + G) * a1
  const A2 = (1 + G) * a2
  const c1 = Math.hypot(A1, b1)
  const c2 = Math.hypot(A2, b2)
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0
    const h = Math.atan2(b, a) / RAD
    return h < 0 ? h + 360 : h
  }
  const h1 = hue(b1, A1)
  const h2 = hue(b2, A2)
  const dL = L2 - L1
  const dC = c2 - c1
  let dh = 0
  if (c1 * c2 !== 0) dh = h2 - h1 > 180 ? h2 - h1 - 360 : h2 - h1 < -180 ? h2 - h1 + 360 : h2 - h1
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * RAD)
  const L = (L1 + L2) / 2
  const C = (c1 + c2) / 2
  let H = h1 + h2
  if (c1 * c2 !== 0)
    H =
      Math.abs(h1 - h2) > 180 ? (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2) : H / 2
  const T =
    1 -
    0.17 * Math.cos((H - 30) * RAD) +
    0.24 * Math.cos(2 * H * RAD) +
    0.32 * Math.cos((3 * H + 6) * RAD) -
    0.2 * Math.cos((4 * H - 63) * RAD)
  const L50 = (L - 50) ** 2
  const SL = 1 + (0.015 * L50) / Math.sqrt(20 + L50)
  const SC = 1 + 0.045 * C
  const SH = 1 + 0.015 * C * T
  const C7m = C ** 7
  const RT =
    -2 * Math.sqrt(C7m / (C7m + 25 ** 7)) * Math.sin(60 * Math.exp(-(((H - 275) / 25) ** 2)) * RAD)
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))
}

/**
 * Measures two RGBA frames of one size as they would be seen: each matted over black, as an mp4
 * shows it. PSNR over R, G and B; ΔE (CIEDE2000) per pixel, its mean and its largest.
 */
export const compareFrames = (
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
): Comparison => {
  const { differing, pixels } = diffPixels(a, b)
  const x = matte(a)
  const y = matte(b)
  let squared = 0
  let sum = 0
  let max = 0
  for (let i = 0; i < x.length; i += 4) {
    const r1 = x[i] as number
    const g1 = x[i + 1] as number
    const b1 = x[i + 2] as number
    const r2 = y[i] as number
    const g2 = y[i + 1] as number
    const b2 = y[i + 2] as number
    squared += (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2
    if (r1 === r2 && g1 === g2 && b1 === b2) continue
    const d = deltaE2000(lab(r1, g1, b1), lab(r2, g2, b2))
    sum += d
    if (d > max) max = d
  }
  const mse = squared / (pixels * 3)
  return {
    psnr: mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse),
    deltaE: sum / pixels,
    maxDeltaE: max,
    differing,
  }
}

/** Two RGBA frames of one size side by side, `a` on the left: one frame twice as wide. */
export const sideBySide = (
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array => {
  const row = width * 4
  const out = new Uint8Array(row * 2 * height)
  for (let y = 0; y < height; y++) {
    out.set(a.subarray(y * row, (y + 1) * row), y * row * 2)
    out.set(b.subarray(y * row, (y + 1) * row), y * row * 2 + row)
  }
  return out
}
