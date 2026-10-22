// The tone maps on the CPU, the same values as tonemap.wgsl.ts gives in a shader: linear light in
// (Rec.709/sRGB primaries, exposed and white balanced, 0 up), linear display-referred light out,
// 0–1. Khronos PBR Neutral and AgX, each as its reference has it. For a swatch, a palette picked to
// match the picture, or a test; the film's frame goes through the WGSL.

/** A colour in linear light (Rec.709/sRGB primaries), not display values. */
export type LinearRgb = readonly [number, number, number]

/**
 * Khronos PBR Neutral (KhronosGroup/ToneMapping, PBR_Neutral): colours below the shoulder pass
 * through as they are; the highlights roll off to white and desaturate.
 */
export const pbrNeutral = (rgb: LinearRgb): [number, number, number] => {
  const start = 0.8 - 0.04
  const desaturation = 0.15
  const x = Math.min(rgb[0], rgb[1], rgb[2])
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  const c = rgb.map((v) => v - offset) as [number, number, number]
  const peak = Math.max(c[0], c[1], c[2])
  if (peak < start) return c
  const d = 1 - start
  const newPeak = 1 - (d * d) / (peak + d - start)
  const g = 1 - 1 / (desaturation * (peak - newPeak) + 1)
  return c.map((v) => {
    const s = (v * newPeak) / peak
    return s + (newPeak - s) * g
  }) as [number, number, number]
}

// WGSL's mat3x3f(c0, c1, c2) is by columns, as these are: M·v = c0·v.x + c1·v.y + c2·v.z.
type M3 = readonly [LinearRgb, LinearRgb, LinearRgb]
const mul = (m: M3, v: LinearRgb): [number, number, number] => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
]
const SRGB_TO_2020: M3 = [
  [0.6274, 0.0691, 0.0164],
  [0.3293, 0.9195, 0.088],
  [0.0433, 0.0113, 0.8956],
]
const REC2020_TO_SRGB: M3 = [
  [1.6605, -0.1246, -0.0182],
  [-0.5876, 1.1329, -0.1006],
  [-0.0728, -0.0083, 1.1187],
]
const INSET: M3 = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
]
const OUTSET: M3 = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
]
const MIN_EV = -12.47393
const MAX_EV = 4.026069
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** AgX's sigmoid, the minimal polynomial fit. */
const contrast = (x: number) => {
  const x2 = x * x
  const x4 = x2 * x2
  return (
    15.5 * x4 * x2 -
    40.14 * x4 * x +
    31.96 * x4 -
    6.868 * x2 * x +
    0.4298 * x2 +
    0.1191 * x -
    0.00232
  )
}

/**
 * AgX as three.js r186 has it (AgXToneMapping, after Filament and Blender), in Rec.2020: the colour
 * inset, a log2 encoding from -12.47393 to 4.026069 EV, the sigmoid, the outset, and the 2.2 power
 * that turns the sigmoid's display values back into linear light.
 */
export const agx = (rgb: LinearRgb): [number, number, number] => {
  const c = mul(INSET, mul(SRGB_TO_2020, rgb)).map((v) =>
    contrast(clamp01((Math.log2(Math.max(v, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV))),
  ) as [number, number, number]
  const linear = mul(OUTSET, c).map((v) => Math.max(v, 0) ** 2.2) as [number, number, number]
  return mul(REC2020_TO_SRGB, linear).map(clamp01) as [number, number, number]
}
