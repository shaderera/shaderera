// A LUT applied in a shader, from the texture lutTexture (lut.ts) makes: tetrahedral for a 3D
// table, linear per channel for a 1D one. applyLut in lut.ts gives the same values on the CPU.
// The LUT's input and output spaces are its author's; the film's shader converts around it.

export const LUT_WGSL = /* wgsl */ `
// A colour through a 3D LUT, clamped to its domain first: tetrahedral, the cell cut into six
// tetrahedra along its grey diagonal and the four corners of the one the colour is in blended.
fn lut3d(lut: texture_3d<f32>, c: vec3f, domainMin: vec3f, domainMax: vec3f) -> vec3f {
  let n = textureDimensions(lut).x;
  let p = clamp((c - domainMin) / (domainMax - domainMin), vec3f(0.0), vec3f(1.0)) * f32(n - 1u);
  let i = min(vec3u(floor(p)), vec3u(n - 2u));
  let f = p - vec3f(i);
  // From c000 to c111 one axis at a time, the axis of the largest fraction first: a and b are the
  // corners on the way, w the fractions in that order.
  var a: vec3u;
  var b: vec3u;
  var w: vec3f;
  if (f.r >= f.g) {
    if (f.g >= f.b) { a = vec3u(1u, 0u, 0u); b = vec3u(1u, 1u, 0u); w = f.rgb; }
    else if (f.r >= f.b) { a = vec3u(1u, 0u, 0u); b = vec3u(1u, 0u, 1u); w = f.rbg; }
    else { a = vec3u(0u, 0u, 1u); b = vec3u(1u, 0u, 1u); w = f.brg; }
  } else if (f.b >= f.g) { a = vec3u(0u, 0u, 1u); b = vec3u(0u, 1u, 1u); w = f.bgr; }
  else if (f.b >= f.r) { a = vec3u(0u, 1u, 0u); b = vec3u(0u, 1u, 1u); w = f.gbr; }
  else { a = vec3u(0u, 1u, 0u); b = vec3u(1u, 1u, 0u); w = f.grb; }
  let c0 = textureLoad(lut, i, 0).rgb;
  let ca = textureLoad(lut, i + a, 0).rgb;
  let cb = textureLoad(lut, i + b, 0).rgb;
  let c1 = textureLoad(lut, i + vec3u(1u), 0).rgb;
  return c0 + w.x * (ca - c0) + w.y * (cb - ca) + w.z * (c1 - cb);
}

// A colour through a 1D LUT, clamped to its domain first: each channel linear between the two
// entries either side.
fn lut1d(lut: texture_2d<f32>, c: vec3f, domainMin: vec3f, domainMax: vec3f) -> vec3f {
  let n = textureDimensions(lut).x;
  let p = clamp((c - domainMin) / (domainMax - domainMin), vec3f(0.0), vec3f(1.0)) * f32(n - 1u);
  let i = min(vec3u(floor(p)), vec3u(n - 2u));
  let lo = vec3f(
    textureLoad(lut, vec2u(i.r, 0u), 0).r,
    textureLoad(lut, vec2u(i.g, 0u), 0).g,
    textureLoad(lut, vec2u(i.b, 0u), 0).b,
  );
  let hi = vec3f(
    textureLoad(lut, vec2u(i.r + 1u, 0u), 0).r,
    textureLoad(lut, vec2u(i.g + 1u, 0u), 0).g,
    textureLoad(lut, vec2u(i.b + 1u, 0u), 0).b,
  );
  return mix(lo, hi, p - vec3f(i));
}
`
