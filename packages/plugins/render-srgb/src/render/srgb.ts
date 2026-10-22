// The sRGB transfer functions (IEC 61966-2-1) on the CPU, one channel at a time: the same values
// srgb.wgsl.ts gives in a shader.

/** A display value (sRGB-encoded, 0–1) to linear light. */
export const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

/** Linear light to a display value, clamped to 0–1 first. */
export const toSrgb = (v: number) => {
  const x = Math.min(Math.max(v, 0), 1)
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055
}
