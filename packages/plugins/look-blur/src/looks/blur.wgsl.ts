// The blur passes. prep: the source in linear light, premultiplied, its highlights lifted past
// white, into level 0 of a pyramid. down: each level from the one below, a 13-tap filter at half
// the size. blur: each pixel gathered from the pyramid by its own amount, encoded back to sRGB,
// premultiplied; where the amount is 0 the source comes back as it was.

import { SRGB_WGSL } from '../render/srgb.wgsl.ts'

const FULL_VS = /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`

// A source pixel in linear light, premultiplied. alpha: 0 premultiplied, 1 straight, 2 opaque;
// linear: the source is already linear (an -srgb texture).
const DECODE = /* wgsl */ `${SRGB_WGSL}
fn decode(s: vec4f, alpha: f32, linear: f32) -> vec4f {
  var c = s;
  let mode = u32(alpha + 0.5);
  if (mode == 2u) { c.a = 1.0; }
  var rgb = c.rgb;
  if (mode == 0u) { rgb = select(vec3f(0.0), rgb / c.a, c.a > 0.0); }
  if (linear < 0.5) { rgb = toLinear(clamp(rgb, vec3f(0.0), vec3f(1.0))); }
  return vec4f(rgb * c.a, c.a);
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
`

export const PREP_WGSL = /* wgsl */ `${FULL_VS}${DECODE}
struct Prep { a: vec4f }  // alpha, linear, highlights, 0

@group(0) @binding(0) var<uniform> u: Prep;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var lin: sampler;

// A display frame stops at white, so a light that was far brighter is white too, and spread out it
// would dim to grey. Near-white pixels are taken to be up to 1 + highlights times as bright.
@fragment fn prepFs(i: V) -> @location(0) vec4f {
  let c = decode(textureSampleLevel(src, lin, i.uv, 0.0), u.a.x, u.a.y);
  let a = max(c.a, 0.000001);
  let t = clamp((luma(c.rgb / a) - 0.6) / 0.4, 0.0, 1.0);
  return vec4f(c.rgb * (1.0 + u.a.z * t * t), c.a);
}
`

export const DOWN_WGSL = /* wgsl */ `${FULL_VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var lin: sampler;

fn s(uv: vec2f) -> vec4f { return textureSampleLevel(src, lin, uv, 0.0); }

// Half the size: 13 bilinear taps, weighted so a hard edge or a lone bright point leaves no grid.
@fragment fn downFs(i: V) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = i.uv;
  let corners = s(uv + t * vec2f(-2.0, -2.0)) + s(uv + t * vec2f(2.0, -2.0)) + s(uv + t * vec2f(-2.0, 2.0)) + s(uv + t * vec2f(2.0, 2.0));
  let sides = s(uv + t * vec2f(0.0, -2.0)) + s(uv + t * vec2f(-2.0, 0.0)) + s(uv + t * vec2f(2.0, 0.0)) + s(uv + t * vec2f(0.0, 2.0));
  let inner = s(uv + t * vec2f(-1.0, -1.0)) + s(uv + t * vec2f(1.0, -1.0)) + s(uv + t * vec2f(-1.0, 1.0)) + s(uv + t * vec2f(1.0, 1.0));
  return s(uv) * 0.125 + corners * 0.03125 + sides * 0.0625 + inner * 0.125;
}
`

export const BLUR_WGSL = /* wgsl */ `${FULL_VS}${DECODE}
struct Blur {
  a: vec4f,  // kind (0 gaussian, 1 bokeh, 2 directional, 3 radial), radius px, base amount, shapes
  b: vec4f,  // angle (rad), radial centre x, y (px), the centre's reach to the farthest corner (px)
  c: vec4f,  // blades, rotation (rad), taps, 0
  d: vec4f,  // map on, depth on, depth focus, depth range
  e: vec4f,  // pyramid levels, source alpha, source linear, 0
  shapes: array<vec4f, 16>,  // per shape: x, y, w, h (px); feather, round, amount, 0
}

@group(0) @binding(0) var<uniform> u: Blur;
@group(0) @binding(1) var work: texture_2d<f32>;
@group(0) @binding(2) var lin: sampler;
@group(0) @binding(3) var amountMap: texture_2d<f32>;
@group(0) @binding(4) var depthMap: texture_2d<f32>;
@group(0) @binding(5) var src: texture_2d<f32>;

// The source itself, not the pyramid: no highlights lifted, so a sharp pixel comes back unchanged.
fn raw(uv: vec2f) -> vec4f { return decode(textureSampleLevel(src, lin, uv, 0.0), u.e.y, u.e.z); }

// The highest level of the pyramid.
fn top() -> u32 { return max(u32(u.e.x), 1u) - 1u; }

// Level k of the pyramid at uv through a cubic B-spline (four bilinear taps): smooth at any level,
// with no blocks or diamonds where a level is much smaller than the frame.
fn bspline(uv: vec2f, level: u32) -> vec4f {
  let k = f32(level);
  let size = vec2f(textureDimensions(work, level));
  let p = uv * size - 0.5;
  let f = fract(p);
  let base = floor(p) + 0.5;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let p0 = (base - 1.0 + w1 / g0) / size;
  let p1 = (base + 1.0 + w3 / g1) / size;
  return g0.x * g0.y * textureSampleLevel(work, lin, vec2f(p0.x, p0.y), k)
    + g1.x * g0.y * textureSampleLevel(work, lin, vec2f(p1.x, p0.y), k)
    + g0.x * g1.y * textureSampleLevel(work, lin, vec2f(p0.x, p1.y), k)
    + g1.x * g1.y * textureSampleLevel(work, lin, vec2f(p1.x, p1.y), k);
}

// Measured: level k of the pyramid read through the B-spline is a Gaussian of this σ, in px.
fn sigmaOf(k: u32) -> f32 {
  if (k == 0u) { return 0.577; }
  if (k == 1u) { return 1.75; }
  if (k == 2u) { return 3.74; }
  return 0.9555 * exp2(f32(k));
}

// A Gaussian of sigma px: the two levels either side, mixed so their variances add up to sigma².
fn gaussian(uv: vec2f, sigma: f32) -> vec4f {
  if (sigma <= 0.0) { return raw(uv); }
  let s0 = sigmaOf(0u);
  if (sigma < s0) { return mix(raw(uv), bspline(uv, 0u), sigma * sigma / (s0 * s0)); }
  let t = top();
  var k = 0u;
  loop {
    if (k >= t || sigmaOf(k + 1u) > sigma) { break; }
    k++;
  }
  if (k >= t) { return bspline(uv, t); }
  let a = sigmaOf(k);
  let b = sigmaOf(k + 1u);
  return mix(bspline(uv, k), bspline(uv, k + 1u), (sigma * sigma - a * a) / (b * b - a * a));
}

// How far out the edge of a regular polygon is at angle th, as a share of its corner radius.
fn polygon(th: f32, n: f32) -> f32 {
  let side = 6.2831853 / n;
  let a = th - side * floor(th / side) - side * 0.5;
  return cos(side * 0.5) / cos(a);
}

// A disc (or a polygon) of radius r, its taps spread evenly on a golden-angle spiral, each read
// from the level whose texels are as far apart as the taps.
fn bokeh(uv: vec2f, r: f32) -> vec4f {
  if (r < 0.5) { return raw(uv); }
  let n = u.c.z;
  let size = vec2f(textureDimensions(work, 0u));
  let lod = clamp(log2(r * sqrt(3.14159265 / n)) - 0.5, 0.0, f32(top()));
  var sum = vec4f(0.0);
  for (var k = 0.0; k < n; k += 1.0) {
    let th = (k + 0.5) * 2.3999632;
    var rr = sqrt((k + 0.5) / n) * r;
    if (u.c.x >= 3.0) { rr *= polygon(th - u.c.y, floor(u.c.x)); }
    sum += textureSampleLevel(work, lin, uv + vec2f(cos(th), sin(th)) * rr / size, lod);
  }
  return sum / n;
}

// An even line of taps from -reach to +reach (px), each from the level that matches their spacing.
fn smear(uv: vec2f, reach: vec2f) -> vec4f {
  let len = length(reach) * 2.0;
  if (len < 1.0) { return raw(uv); }
  let n = u.c.z;
  let size = vec2f(textureDimensions(work, 0u));
  let lod = clamp(log2(len / n), 0.0, f32(top()));
  var sum = vec4f(0.0);
  for (var k = 0.0; k < n; k += 1.0) {
    sum += textureSampleLevel(work, lin, uv + reach * ((k + 0.5) / n * 2.0 - 1.0) / size, lod);
  }
  return sum / n;
}

// The amount at a pixel: the base, each shape painted over it in order, then the map and depth.
fn amountAt(px: vec2f, uv: vec2f) -> f32 {
  var a = u.a.z;
  for (var i = 0u; i < u32(u.a.w); i++) {
    let box = u.shapes[i * 2u];
    let s = u.shapes[i * 2u + 1u];
    let half = box.zw * 0.5;
    let round = min(s.y, min(half.x, half.y));
    let q = abs(px - box.xy - half) - half + round;
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - round;
    a = mix(a, s.z, 1.0 - smoothstep(0.0, max(s.x, 0.001), d));
  }
  if (u.d.x > 0.5) {
    let m = textureSampleLevel(amountMap, lin, uv, 0.0);
    a *= m.r * m.a;
  }
  if (u.d.y > 0.5) {
    let z = textureLoad(depthMap, vec2u(px), 0).r;
    a *= clamp(abs(z - u.d.z) / max(u.d.w, 0.000001), 0.0, 1.0);
  }
  return clamp(a, 0.0, 1.0);
}

@fragment fn blurFs(i: V) -> @location(0) vec4f {
  let px = i.pos.xy;
  let r = amountAt(px, i.uv) * u.a.y;
  let kind = u32(u.a.x + 0.5);
  var c: vec4f;
  if (kind == 0u) {
    c = gaussian(i.uv, r * 0.5);
  } else if (kind == 1u) {
    c = bokeh(i.uv, r);
  } else if (kind == 2u) {
    c = smear(i.uv, vec2f(cos(u.b.x), sin(u.b.x)) * r);
  } else {
    c = smear(i.uv, (px - u.b.yz) / max(u.b.w, 1.0) * r);
  }
  // Lifted highlights may pass white; alpha stays within 0–1.
  let a = clamp(c.a, 0.0, 1.0);
  let rgb = select(vec3f(0.0), c.rgb / max(c.a, 0.000001), c.a > 0.0);
  return vec4f(toSrgb(rgb) * a, a);
}
`
