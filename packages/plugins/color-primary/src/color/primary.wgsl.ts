// Primary grading as WGSL functions to put in a shader: primary.ts gives the same values on the
// CPU, and builds the white balance matrix (whiteBalance, then toMat3x3f) a shader multiplies by.

export const PRIMARY_WGSL = /* wgsl */ `
// x^p for x from 0, with 0^p = 0 (WGSL leaves pow(0, p) to the GPU).
fn primaryPow(x: vec3f, p: vec3f) -> vec3f {
  return select(vec3f(0.0), pow(x, p), x > vec3f(0.0));
}

// The ASC CDL v1.2: per channel out = clamp(in * slope + offset)^power, then saturation around
// Rec.709 luma (0.2126, 0.7152, 0.0722), clamped to 0-1 again.
fn cdl(c: vec3f, slope: vec3f, offset: vec3f, power: vec3f, saturation: f32) -> vec3f {
  let sop = primaryPow(clamp(c * slope + offset, vec3f(0.0), vec3f(1.0)), power);
  let luma = dot(sop, vec3f(0.2126, 0.7152, 0.0722));
  return clamp(luma + saturation * (sop - luma), vec3f(0.0), vec3f(1.0));
}

// Light times 2^stops.
fn exposure(c: vec3f, stops: f32) -> vec3f {
  return c * exp2(stops);
}

// Contrast of scene-linear light around a pivot (above 0): pivot * (in / pivot)^amount; 0 and
// negatives pass through.
fn contrast(c: vec3f, amount: f32, pivot: f32) -> vec3f {
  return select(c, pivot * pow(c / pivot, vec3f(amount)), c > vec3f(0.0));
}
`
