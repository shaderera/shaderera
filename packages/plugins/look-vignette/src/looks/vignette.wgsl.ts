// The vignette: the frame darkened (or tinted) towards its edges, in linear light, from a round
// falloff to one that follows the frame's own shape, or round an ellipse of a given size. It reads
// a finished frame and writes one.

export const VIGNETTE_WGSL = /* wgsl */ `
struct Vignette {
  a: vec4f,  // amount 0–1, start (0 centre … 1 corner), roundness 0–1, 1 if the ellipse is given
  b: vec4f,  // centre x, y (px), ellipse radii x, y (px)
  c: vec4f,  // colour rgb (display values), 0
}

@group(0) @binding(0) var<uniform> u: Vignette;
@group(0) @binding(1) var src: texture_2d<f32>;

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn toSrgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}

@fragment fn vignetteFs(i: V) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let c = textureLoad(src, vec2u(i.pos.xy), 0).rgb;
  let q = i.pos.xy - u.b.xy;
  // 1 at a corner of the frame: an ellipse of the frame's proportions, or a circle; or 1 at the
  // edge of the given ellipse.
  let frame = length(q / (size * 0.5)) / 1.4142136;
  let round = length(q) / (0.5 * length(size));
  var d = mix(frame, round, u.a.z);
  if (u.a.w > 0.0) {
    // a radius of 0 or less is a closed ellipse: everything dims, as it does as one shrinks to 0
    d = length(q / max(u.b.zw, vec2f(1e-4)));
  }
  let f = u.a.x * smoothstep(u.a.y, 1.0, d);
  return vec4f(toSrgb(mix(toLinear(c), toLinear(u.c.rgb), f)), 1.0);
}
`
