// A displacement map: each pixel of the output shows the source from where the map moves it, read
// bilinearly on premultiplied values so a moved edge has no halo. A map value of 0.5 moves nothing.

export const DISPLACE_WGSL = /* wgsl */ `
struct Displace {
  amount: vec2f,      // the most each axis moves, px (0: that axis does not move)
  edges: u32,         // 0 clamp, 1 wrap, 2 transparent
  sourceAlpha: u32,   // 0 straight, 1 premultiplied, 2 opaque
  channels: vec2u,    // per axis: 0 red, 1 green, 2 blue, 3 alpha, 4 luma
  mapAlpha: u32,      // how the map's alpha is stored
  pad: u32,
}

@group(0) @binding(0) var<uniform> u: Displace;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var map: texture_2d<f32>;

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

fn channel(c: vec4f, k: u32) -> f32 {
  switch k {
    case 0u: { return c.r; }
    case 1u: { return c.g; }
    case 2u: { return c.b; }
    case 3u: { return c.a; }
    default: { return dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)); }
  }
}

// One source pixel, premultiplied, with the edge rule past the frame.
fn tap(q: vec2i, size: vec2i) -> vec4f {
  var p = q;
  if (any(p < vec2i(0)) || any(p >= size)) {
    if (u.edges == 2u) { return vec4f(0.0); }
    if (u.edges == 1u) { p = ((p % size) + size) % size; } else { p = clamp(p, vec2i(0), size - 1); }
  }
  let c = textureLoad(source, vec2u(p), 0);
  if (u.sourceAlpha == 0u) { return vec4f(c.rgb * c.a, c.a); }
  if (u.sourceAlpha == 2u) { return vec4f(c.rgb, 1.0); }
  return c;
}

@fragment fn displaceFs(i: V) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(source));
  let m = straight(textureLoad(map, vec2u(i.pos.xy), 0), u.mapAlpha);
  let v = vec2f(channel(m, u.channels.x), channel(m, u.channels.y));
  // a light value moves the picture right (down): the output reads from the other way
  let at = i.pos.xy - (v - 0.5) * 2.0 * u.amount - 0.5;
  let f = floor(at);
  let t = at - f;
  let q = vec2i(f);
  let a = mix(tap(q, size), tap(q + vec2i(1, 0), size), t.x);
  let b = mix(tap(q + vec2i(0, 1), size), tap(q + vec2i(1, 1), size), t.x);
  return mix(a, b, t.y);
}
`
