// Colour spaces on the CPU, the same values spaces.wgsl.ts gives in a shader: the ACEScct and
// ACEScc log curves, BT.1886 and the camera log curves, one channel at a time, and the 3×3 gamut
// matrices between Rec.709, Rec.2020, P3-D65, ACES AP0 and AP1 and the camera gamuts, through
// CIE XYZ, with a Bradford adaptation when the whites differ. The matrix helpers are
// color-primary's.

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

// The camera curves take and give code values, a 10-bit code / 1023, as the vendors define them.

/** S-Log3 to linear light (Sony's S-Log3 technical summary): a line below code 171.21. */
export const slog3ToLinear = (v: number) =>
  v >= 171.2102946929 / 1023
    ? 10 ** ((v * 1023 - 420) / 261.5) * 0.19 - 0.01
    : ((v * 1023 - 95) * 0.01125) / (171.2102946929 - 95)

/** Linear light to S-Log3: log10 above 0.01125, a line below; 0 is code 95, 18% grey 420. */
export const linearToSlog3 = (v: number) =>
  v >= 0.01125
    ? (420 + Math.log10((v + 0.01) / 0.19) * 261.5) / 1023
    : ((v * (171.2102946929 - 95)) / 0.01125 + 95) / 1023

/** ARRI LogC3 at EI 800 to linear light (ARRI's LogC curve in VFX): a line below 0.149658. */
export const logc3ToLinear = (v: number) =>
  v > 0.149658
    ? (10 ** ((v - 0.385537) / 0.24719) - 0.052272) / 5.555556
    : (v - 0.092809) / 5.367655

/** Linear light to ARRI LogC3 at EI 800: log10 above 0.010591; 18% grey is 0.391007. */
export const linearToLogc3 = (v: number) =>
  v > 0.010591 ? 0.24719 * Math.log10(5.555556 * v + 0.052272) + 0.385537 : 5.367655 * v + 0.092809

// ARRI LogC4 (ARRI's LogC4 specification): a, b and c, the toe's slope s and its break t, linear.
const LOGC4_A = (2 ** 18 - 16) / 117.45
const LOGC4_B = (1023 - 95) / 1023
const LOGC4_C = 95 / 1023
const LOGC4_S = (7 * Math.LN2 * 2 ** (7 - (14 * LOGC4_C) / LOGC4_B)) / (LOGC4_A * LOGC4_B)
const LOGC4_T = (2 ** (6 - (14 * LOGC4_C) / LOGC4_B) - 64) / LOGC4_A

/** ARRI LogC4 to linear light: log2 from code value 0, a line below. */
export const logc4ToLinear = (v: number) =>
  v >= 0 ? (2 ** ((14 * (v - LOGC4_C)) / LOGC4_B + 6) - 64) / LOGC4_A : v * LOGC4_S + LOGC4_T

/** Linear light to ARRI LogC4: 0 is code 95, 18% grey 0.278396; a line below -0.018057. */
export const linearToLogc4 = (v: number) =>
  v >= LOGC4_T
    ? ((Math.log2(LOGC4_A * v + 64) - 6) / 14) * LOGC4_B + LOGC4_C
    : (v - LOGC4_T) / LOGC4_S

/** Panasonic V-Log to linear light (V-Log/V-Gamut reference manual): a line below 0.181. */
export const vlogToLinear = (v: number) =>
  v < 0.181 ? (v - 0.125) / 5.6 : 10 ** ((v - 0.598206) / 0.241514) - 0.00873

/** Linear light to Panasonic V-Log: log10 above 0.01; 0 is 0.125 (code 128), 18% grey 433. */
export const linearToVlog = (v: number) =>
  v < 0.01 ? 5.6 * v + 0.125 : 0.241514 * Math.log10(v + 0.00873) + 0.598206

/**
 * Canon Log 3 to linear light (Canon's full-range formula): log10 both ways from a line through
 * code 128. Canon's linear is 1 at 90% white, so it is scaled by 0.9, as the ACES IDTs do.
 */
export const clog3ToLinear = (v: number) =>
  0.9 *
  (v < 0.097465473
    ? -(10 ** ((0.12783901 - v) / 0.36726845) - 1) / 14.98325
    : v <= 0.15277891
      ? (v - 0.12512219) / 1.9754798
      : (10 ** ((v - 0.12240537) / 0.36726845) - 1) / 14.98325)

/** Linear light to Canon Log 3: 0 is code 128, 18% grey 351. */
export const linearToClog3 = (v: number) => {
  const x = v / 0.9
  return x < -0.014
    ? -0.36726845 * Math.log10(1 - 14.98325 * x) + 0.12783901
    : x <= 0.014
      ? 1.9754798 * x + 0.12512219
      : 0.36726845 * Math.log10(14.98325 * x + 1) + 0.12240537
}

/** Each camera curve's decoding, by the transfer name a film declares (`clip.space.transfer`). */
export const TO_LINEAR = {
  slog3: slog3ToLinear,
  logc3: logc3ToLinear,
  logc4: logc4ToLinear,
  vlog: vlogToLinear,
  clog3: clog3ToLinear,
} as const

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
  /** Sony S-Gamut3. */
  sgamut3: { red: [0.73, 0.28], green: [0.14, 0.855], blue: [0.1, -0.05], white: D65 },
  /** Sony S-Gamut3.Cine. */
  sgamut3cine: { red: [0.766, 0.275], green: [0.225, 0.8], blue: [0.089, -0.087], white: D65 },
  /** ARRI Wide Gamut 3 (LogC3's). */
  awg3: { red: [0.684, 0.313], green: [0.221, 0.848], blue: [0.0861, -0.102], white: D65 },
  /** ARRI Wide Gamut 4 (LogC4's). */
  awg4: { red: [0.7347, 0.2653], green: [0.1424, 0.8576], blue: [0.0991, -0.0308], white: D65 },
  /** Panasonic V-Gamut. */
  vgamut: { red: [0.73, 0.28], green: [0.165, 0.84], blue: [0.1, -0.03], white: D65 },
  /** Canon Cinema Gamut. */
  cinemagamut: { red: [0.74, 0.27], green: [0.17, 1.14], blue: [0.08, -0.1], white: D65 },
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
