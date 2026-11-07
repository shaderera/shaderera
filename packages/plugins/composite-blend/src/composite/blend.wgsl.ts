// The blend modes of W3C Compositing and Blending Level 1 (https://www.w3.org/TR/compositing-1/),
// to the letter, plus `add` (Photoshop's Linear Dodge), and the spec's general compositing formula
// with source-over. blend.ts gives the same values on the CPU.

import { SRGB_WGSL } from '../render/srgb.wgsl.ts'

/** The modes in the order of their index in the shader. */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'add',
] as const

export const BLEND_WGSL = /* wgsl */ `${SRGB_WGSL}
struct Blend {
  mode: u32,       // index in BLEND_MODES
  linear: u32,     // 1: blend in linear light, 0: in display values
  baseAlpha: u32,  // 0 straight, 1 premultiplied, 2 opaque
  layerAlpha: u32, // the same, for the layer
  amount: f32,     // scales the layer's alpha
}

@group(0) @binding(0) var<uniform> u: Blend;
@group(0) @binding(1) var base: texture_2d<f32>;
@group(0) @binding(2) var layer: texture_2d<f32>;

struct V { @builtin(position) pos: vec4f }

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

// A pixel as straight colour and alpha, by how its alpha is stored.
fn straight(c: vec4f, kind: u32) -> vec4f {
  if (kind == 2u) { return vec4f(c.rgb, 1.0); }
  if (kind == 1u) {
    if (c.a <= 0.0) { return vec4f(0.0); }
    return vec4f(c.rgb / c.a, c.a);
  }
  return c;
}

fn hardLight1(cb: f32, cs: f32) -> f32 {
  if (cs <= 0.5) { return cb * 2.0 * cs; }
  let s = 2.0 * cs - 1.0;
  return cb + s - cb * s;
}

fn colorDodge1(cb: f32, cs: f32) -> f32 {
  if (cb == 0.0) { return 0.0; }
  if (cs >= 1.0) { return 1.0; }
  return min(1.0, cb / (1.0 - cs));
}

fn colorBurn1(cb: f32, cs: f32) -> f32 {
  if (cb >= 1.0) { return 1.0; }
  if (cs <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - cb) / cs);
}

fn softLight1(cb: f32, cs: f32) -> f32 {
  if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
  var d: f32;
  if (cb <= 0.25) { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; } else { d = sqrt(cb); }
  return cb + (2.0 * cs - 1.0) * (d - cb);
}

fn lum(c: vec3f) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }

fn clipColor(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  var o = c;
  if (n < 0.0) { o = l + (o - l) * l / (l - n); }
  if (x > 1.0) { o = l + (o - l) * (1.0 - l) / (x - l); }
  return o;
}

fn setLum(c: vec3f, l: f32) -> vec3f { return clipColor(c + (l - lum(c))); }

fn sat(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

fn setSat(c: vec3f, s: f32) -> vec3f {
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (x > n) { return (c - n) * s / (x - n); }
  return vec3f(0.0);
}

fn blendRgb(m: u32, cb: vec3f, cs: vec3f) -> vec3f {
  switch m {
    case 1u: { return cb * cs; }
    case 2u: { return cb + cs - cb * cs; }
    case 3u: { return vec3f(hardLight1(cs.r, cb.r), hardLight1(cs.g, cb.g), hardLight1(cs.b, cb.b)); }
    case 4u: { return min(cb, cs); }
    case 5u: { return max(cb, cs); }
    case 6u: { return vec3f(colorDodge1(cb.r, cs.r), colorDodge1(cb.g, cs.g), colorDodge1(cb.b, cs.b)); }
    case 7u: { return vec3f(colorBurn1(cb.r, cs.r), colorBurn1(cb.g, cs.g), colorBurn1(cb.b, cs.b)); }
    case 8u: { return vec3f(hardLight1(cb.r, cs.r), hardLight1(cb.g, cs.g), hardLight1(cb.b, cs.b)); }
    case 9u: { return vec3f(softLight1(cb.r, cs.r), softLight1(cb.g, cs.g), softLight1(cb.b, cs.b)); }
    case 10u: { return abs(cb - cs); }
    case 11u: { return cb + cs - 2.0 * cb * cs; }
    case 12u: { return setLum(setSat(cs, sat(cb)), lum(cb)); }
    case 13u: { return setLum(setSat(cb, sat(cs)), lum(cb)); }
    case 14u: { return setLum(cs, lum(cb)); }
    case 15u: { return setLum(cb, lum(cs)); }
    case 16u: { return min(vec3f(1.0), cb + cs); }
    default: { return cs; }
  }
}

@fragment fn blendFs(i: V) -> @location(0) vec4f {
  let p = vec2u(i.pos.xy);
  let b = straight(textureLoad(base, p, 0), u.baseAlpha);
  let s = straight(textureLoad(layer, p, 0), u.layerAlpha);
  var cb = b.rgb;
  var cs = s.rgb;
  if (u.linear == 1u) {
    cb = toLinear(cb);
    cs = toLinear(cs);
  }
  let ab = b.a;
  let as_ = s.a * clamp(u.amount, 0.0, 1.0);
  // The spec's general formula: the layer's colour mixed with the blend where the base is, then
  // source-over. Premultiplied.
  let co = as_ * (1.0 - ab) * cs + as_ * ab * blendRgb(u.mode, cb, cs) + (1.0 - as_) * ab * cb;
  let ao = as_ + ab * (1.0 - as_);
  if (ao <= 0.0) { return vec4f(0.0); }
  var c = co / ao;
  if (u.linear == 1u) { c = toSrgb(c); }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)) * ao, ao);
}
`
