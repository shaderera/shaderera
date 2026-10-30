// Primary grading on the CPU, the same values primary.wgsl.ts gives in a shader: the ASC CDL
// (v1.2), exposure in stops, contrast around a pivot, and the white balance matrix (a Bradford
// adaptation, Rec.709 primaries) a shader multiplies by. Every default is identity on 0–1.

type Rgb = readonly [number, number, number]
type Xy = readonly [number, number]
/** A 3×3 matrix, row by row: out = m · in. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)
// x^p for x from 0, with 0^p = 0, as the WGSL has it.
const pow0 = (x: number, p: number) => (x > 0 ? x ** p : 0)

/**
 * The ASC CDL v1.2: per channel out = clamp(in × slope + offset)^power, then saturation around
 * Rec.709 luma (0.2126, 0.7152, 0.0722), clamped to 0–1 again.
 */
export const cdl = (
  rgb: Rgb,
  slope: Rgb = [1, 1, 1],
  offset: Rgb = [0, 0, 0],
  power: Rgb = [1, 1, 1],
  saturation = 1,
): [number, number, number] => {
  const sop = (c: 0 | 1 | 2) => pow0(clamp01(rgb[c] * slope[c] + offset[c]), power[c])
  const [r, g, b] = [sop(0), sop(1), sop(2)]
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [r, g, b].map((v) => clamp01(luma + saturation * (v - luma))) as [number, number, number]
}

/** Light times 2^stops. */
export const exposure = (rgb: Rgb, stops = 0) =>
  rgb.map((v) => v * 2 ** stops) as [number, number, number]

/**
 * Contrast of scene-linear light around a pivot (mid grey by default): pivot × (in / pivot)^amount,
 * a straight line in log. The pivot stays where it is; 0 and negatives pass through. A pivot
 * of 0 or less throws.
 */
export const contrast = (rgb: Rgb, amount = 1, pivot = 0.18) => {
  if (!(pivot > 0)) throw new Error(`contrast: the pivot must be above 0, not ${pivot}`)
  return rgb.map((v) => (v > 0 ? pivot * (v / pivot) ** amount : v)) as [number, number, number]
}

/** The D65 white point (CIE 15), xy. */
export const D65: Xy = [0.3127, 0.329]

/**
 * The xy of a colour temperature in Kelvin, 1667–25000 K: the Planckian locus by Kim et al.'s
 * cubic spline (US patent 7,024,034, 2006), as cameras and DNG take it. 2856 K is illuminant A;
 * 6504 K is the black body at 6504 K (0.3134, 0.3236), not D65, which sits above the locus.
 */
export const kelvinToXy = (kelvin: number): [number, number] => {
  const t = kelvin
  if (!(t >= 1667 && t <= 25000)) throw new Error(`kelvinToXy: ${t} K is out of range: 1667–25000`)
  const x =
    t < 4000
      ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039
  const y =
    t < 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : t < 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483
  return [x, y]
}

/** Two matrices multiplied: applying mul(a, b) is applying b, then a. */
export const mul = (a: Mat3, b: Mat3): Mat3 =>
  Array.from({ length: 9 }, (_, k) => {
    const [i, j] = [k - (k % 3), k % 3]
    const [p = 0, q = 0, r = 0] = a.slice(i, i + 3)
    const [u = 0, v = 0, w = 0] = [b[j], b[3 + j], b[6 + j]]
    return p * u + q * v + r * w
  }) as unknown as Mat3

/** A matrix's inverse. */
export const inverse = (m: Mat3): Mat3 => {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((v) => v / det) as unknown as Mat3
}

/** A matrix times a colour. */
export const applyMatrix = (m: Mat3, rgb: Rgb): [number, number, number] => [
  m[0] * rgb[0] + m[1] * rgb[1] + m[2] * rgb[2],
  m[3] * rgb[0] + m[4] * rgb[1] + m[5] * rgb[2],
  m[6] * rgb[0] + m[7] * rgb[1] + m[8] * rgb[2],
]

const xyz = ([x, y]: Xy): Rgb => [x / y, 1, (1 - x - y) / y]

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]

/** The Bradford chromatic adaptation from one white to another, xy, as a matrix on XYZ. */
export const bradford = (source: Xy, target: Xy = D65): Mat3 => {
  const s = applyMatrix(BRADFORD, xyz(source))
  const t = applyMatrix(BRADFORD, xyz(target))
  const scale: Mat3 = [t[0] / s[0], 0, 0, 0, t[1] / s[1], 0, 0, 0, t[2] / s[2]]
  return mul(inverse(BRADFORD), mul(scale, BRADFORD))
}

// Linear Rec.709 / sRGB to XYZ, from its primaries and D65 (ITU-R BT.709).
const REC709_TO_XYZ = (() => {
  const [r, g, b] = [xyz([0.64, 0.33]), xyz([0.3, 0.6]), xyz([0.15, 0.06])]
  const m: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]]
  const [sr, sg, sb] = applyMatrix(inverse(m), xyz(D65))
  return mul(m, [sr, 0, 0, 0, sg, 0, 0, 0, sb])
})()

/**
 * The white balance matrix for linear Rec.709 light: what was lit by the source white (xy, from
 * kelvinToXy or measured off a grey card) shown as if lit by the target, D65 by default, through
 * Bradford. Both D65 is identity.
 */
export const whiteBalance = (source: Xy = D65, target: Xy = D65): Mat3 =>
  mul(inverse(REC709_TO_XYZ), mul(bradford(source, target), REC709_TO_XYZ))

/** A matrix as a WGSL mat3x3f in a uniform or storage buffer: three columns, each padded to four. */
export const toMat3x3f = (m: Mat3) =>
  new Float32Array([m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0])
