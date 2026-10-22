// The sRGB transfer functions (IEC 61966-2-1) as WGSL functions to put in a shader: srgb.ts gives
// the same values on the CPU.

export const SRGB_WGSL = /* wgsl */ `
// A display value (sRGB-encoded, 0–1) to linear light.
fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// Linear light to a display value, clamped to 0–1 first.
fn toSrgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
`
