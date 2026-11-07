// A track matte: the source's alpha times the matte's luma (Rec. 709 of its display values, times
// its own alpha) or its alpha, optionally turned over. Premultiplied out.

export const MATTE_WGSL = /* wgsl */ `
struct Matte {
  luma: u32,        // 1: the matte's luma, 0: its alpha
  invert: u32,      // 1: the matte turned over
  sourceAlpha: u32, // 0 straight, 1 premultiplied, 2 opaque
  matteAlpha: u32,  // the same, for the matte
}

@group(0) @binding(0) var<uniform> u: Matte;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var matte: texture_2d<f32>;

struct V { @builtin(position) pos: vec4f }

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn straight(c: vec4f, kind: u32) -> vec4f {
  if (kind == 2u) { return vec4f(c.rgb, 1.0); }
  if (kind == 1u) {
    if (c.a <= 0.0) { return vec4f(0.0); }
    return vec4f(c.rgb / c.a, c.a);
  }
  return c;
}

@fragment fn matteFs(i: V) -> @location(0) vec4f {
  let p = vec2u(i.pos.xy);
  let s = straight(textureLoad(source, p, 0), u.sourceAlpha);
  let m = straight(textureLoad(matte, p, 0), u.matteAlpha);
  var k = m.a;
  if (u.luma == 1u) { k = dot(m.rgb, vec3f(0.2126, 0.7152, 0.0722)) * m.a; }
  if (u.invert == 1u) { k = 1.0 - k; }
  let a = s.a * clamp(k, 0.0, 1.0);
  return vec4f(s.rgb * a, a);
}
`
