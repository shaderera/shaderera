// Film grain over a finished frame (display values, 0–1): Gaussian noise of a set size, kept at
// the same strength at any size, strongest in the mid-tones, the same on every channel or apart.

export const GRAIN_WGSL = /* wgsl */ `
struct Grain {
  a: vec4f,  // amount (σ in display values), size px, colour 0–1, seed
  b: vec4f,  // mid-tones 0–1, 0, 0, 0
}

@group(0) @binding(0) var<uniform> u: Grain;
@group(0) @binding(1) var src: texture_2d<f32>;

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn hash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Near enough a unit Gaussian at a lattice point: four uniform values summed, centred, scaled.
fn gauss(cell: vec2f, ch: f32) -> f32 {
  let s = u.a.w * 7.0 + ch * 131.0;
  let sum = hash(vec3f(cell, s)) + hash(vec3f(cell, s + 17.0)) + hash(vec3f(cell + 0.5, s + 31.0)) + hash(vec3f(cell + 0.25, s + 47.0));
  return (sum - 2.0) * 1.7320508;
}

// Grain of size px: the lattice values blended smoothly between, divided back to a unit variance.
fn grain(px: vec2f, ch: f32) -> f32 {
  let size = max(u.a.y, 1.0);
  if (size <= 1.0) { return gauss(floor(px), ch); }
  let q = px / size;
  let i = floor(q);
  let f = fract(q);
  let w = f * f * (3.0 - 2.0 * f);
  let w00 = (1.0 - w.x) * (1.0 - w.y);
  let w10 = w.x * (1.0 - w.y);
  let w01 = (1.0 - w.x) * w.y;
  let w11 = w.x * w.y;
  let n = w00 * gauss(i, ch) + w10 * gauss(i + vec2f(1.0, 0.0), ch) + w01 * gauss(i + vec2f(0.0, 1.0), ch) + w11 * gauss(i + vec2f(1.0, 1.0), ch);
  return n / sqrt(w00 * w00 + w10 * w10 + w01 * w01 + w11 * w11);
}

@fragment fn grainFs(i: V) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(i.pos.xy), 0).rgb;
  let l = clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  // Strongest at mid-grey; mid-tones 1 leaves pure black and white clean.
  let k = u.a.x * mix(1.0, 4.0 * l * (1.0 - l), u.b.x);
  let mono = grain(i.pos.xy, 0.0);
  var n = vec3f(mono);
  if (u.a.z > 0.0) {
    n = mix(n, vec3f(grain(i.pos.xy, 1.0), grain(i.pos.xy, 2.0), grain(i.pos.xy, 3.0)), u.a.z);
  }
  return vec4f(clamp(c + n * k, vec3f(0.0), vec3f(1.0)), 1.0);
}
`
