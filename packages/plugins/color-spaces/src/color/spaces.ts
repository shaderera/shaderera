// Colour spaces on the CPU, the same values spaces.wgsl.ts gives in a shader: the ACEScct and
// ACEScc log curves and BT.1886, one channel at a time, and the 3×3 gamut matrices between
// Rec.709, Rec.2020, P3-D65, ACES AP0 and AP1, through CIE XYZ, with a Bradford adaptation when
// the whites differ. The matrix helpers are color-primary's.

import { applyMatrix, bradford, D65, inverse, type Mat3, mul } from './primary.ts'

type Xy = readonly [number, number]

const HALF_MAX = 65504

/** Linear light to ACEScct (S-2016-001): a straight toe below 2^-7, log2 above it. */
export const linearToAcescct = (v: number) =>
  v <= 0.0078125 ? 10.5402377416545 * v + 0.0729055341958355 : (Math.log2(v) + 9.72) / 17.52

/** ACEScct to linear light (S-2016-001), no more than 65504, half float's largest. */
export const acescctToLinear = (v: number) =>
  v <= 0.155251141552511
    ? (v - 0.0729055341958355) / 10.5402377416545
    : Math.min(2 ** (v * 17.52 - 9.72), HALF_MAX)

/** Linear light to ACEScc (S-2014-003): log2, eased below 2^-15; 0 and below give its floor. */
export const linearToAcescc = (v: number) =>
  v < 2 ** -15
    ? (Math.log2(2 ** -16 + Math.max(v, 0) * 0.5) + 9.72) / 17.52
    : (Math.log2(v) + 9.72) / 17.52

/** ACEScc to linear light (S-2014-003), no more than 65504. */
export const acesccToLinear = (v: number) =>
  v < (9.72 - 15) / 17.52
    ? (2 ** (v * 17.52 - 9.72) - 2 ** -16) * 2
    : Math.min(2 ** (v * 17.52 - 9.72), HALF_MAX)

/** A BT.1886 display value to linear light: V^2.4 (white 1, black 0); below 0 is 0. */
export const bt1886ToLinear = (v: number) => (v > 0 ? v ** 2.4 : 0)

/** Linear light to a BT.1886 display value: L^(1/2.4); below 0 is 0. */
export const linearToBt1886 = (v: number) => (v > 0 ? v ** (1 / 2.4) : 0)

/** A gamut: its red, green and blue primaries and its white, CIE 1931 xy. */
export type Gamut = { readonly red: Xy; readonly green: Xy; readonly blue: Xy; readonly white: Xy }

/** The ACES white (S-2014-004), near D60. */
export const ACES_WHITE: Xy = [0.32168, 0.33767]

/** The gamuts, by name: their primaries and whites as each standard publishes them. */
export const GAMUTS = {
  /** ITU-R BT.709, sRGB's primaries too. */
  rec709: { red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], white: D65 },
  /** ITU-R BT.2020. */
  rec2020: { red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046], white: D65 },
  /** SMPTE EG 432-1 P3 with a D65 white (Display P3's primaries). */
  p3d65: { red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06], white: D65 },
  /** ACES AP0, ACES2065-1 (S-2014-004). */
  ap0: { red: [0.7347, 0.2653], green: [0, 1], blue: [0.0001, -0.077], white: ACES_WHITE },
  /** ACES AP1, ACEScg, ACEScct and ACEScc (S-2014-004). */
  ap1: { red: [0.713, 0.293], green: [0.165, 0.83], blue: [0.128, 0.044], white: ACES_WHITE },
} as const satisfies Record<string, Gamut>

export type GamutName = keyof typeof GAMUTS

const xyz = ([x, y]: Xy) => [x / y, 1, (1 - x - y) / y] as const
const gamut = (g: GamutName | Gamut): Gamut => (typeof g === 'string' ? GAMUTS[g] : g)

/** The matrix from a gamut's linear RGB to CIE XYZ, its white at Y = 1 (SMPTE RP 177). */
export const rgbToXyz = (g: GamutName | Gamut): Mat3 => {
  const { red, green, blue, white } = gamut(g)
  const [r, gr, b] = [xyz(red), xyz(green), xyz(blue)]
  const m: Mat3 = [r[0], gr[0], b[0], r[1], gr[1], b[1], r[2], gr[2], b[2]]
  const [sr, sg, sb] = applyMatrix(inverse(m), xyz(white))
  return mul(m, [sr, 0, 0, 0, sg, 0, 0, 0, sb])
}

/** The matrix from CIE XYZ to a gamut's linear RGB. */
export const xyzToRgb = (g: GamutName | Gamut): Mat3 => inverse(rgbToXyz(g))

/**
 * The matrix from one gamut's linear RGB to another's: to XYZ, a Bradford adaptation from one
 * white to the other when they differ (the CAT ACES recommends), and back. Multiply linear light
 * by it, never log or display values.
 */
export const gamutMatrix = (from: GamutName | Gamut, to: GamutName | Gamut): Mat3 => {
  const [a, b] = [gamut(from), gamut(to)]
  const same = a.white[0] === b.white[0] && a.white[1] === b.white[1]
  const toXyz = same ? rgbToXyz(a) : mul(bradford(a.white, b.white), rgbToXyz(a))
  return mul(xyzToRgb(b), toXyz)
}
