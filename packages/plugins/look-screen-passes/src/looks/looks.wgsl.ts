// The looks pass: the same frame in another medium, plus a row glitch, vignette and grain. It reads
// a finished frame (display values, 0–1) and writes one.

export const LOOKS_WGSL = /* wgsl */ `
struct Look {
  a: vec4f,  // mode (0 none, 1 ascii, 2 halftone, 3 dither, 4 heat, 5 contours, 6 pixels, 7 inverse), amount, cell px, seed
  b: vec4f,  // glitch: share of rows thrown, share of thrown rows sorted, throw (share of width), 0
  c: vec4f,  // vignette, grain, 0, 0
}

@group(0) @binding(0) var<uniform> u: Look;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var lin: sampler;
@group(0) @binding(3) var atlas: texture_2d<f32>;

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

fn rowHash(r: f32, seed: f32) -> f32 { return hash(vec3f(r, seed, 7.0)); }

fn scene(uv: vec2f) -> vec3f { return textureSampleLevel(src, lin, uv, 0.0).rgb; }

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.59, 0.11)); }

fn heat(t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 1.0) * 4.0;
  let k = array(vec3f(0.0, 0.0, 0.03), vec3f(0.22, 0.03, 0.48), vec3f(0.86, 0.12, 0.38), vec3f(1.0, 0.55, 0.08), vec3f(1.0, 0.98, 0.86));
  let i = min(u32(t), 3u);
  return mix(k[i], k[i + 1u], t - f32(i));
}

fn bayer(p: vec2u) -> f32 {
  let m = array(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(p.y % 4u) * 4u + p.x % 4u] + 0.5) / 16.0;
}

fn look(uv: vec2f, px: vec2f, c: vec3f) -> vec3f {
  let mode = i32(u.a.x + 0.5);
  let size = vec2f(textureDimensions(src));
  let cell = max(u.a.z, 2.0);
  if (mode == 1) {
    // ASCII: each 10 x 18 cell is the glyph whose ink matches the cell's light, averaged over a
    // 3 x 3 sample so sparse points still register.
    let cs = vec2f(10.0, 18.0);
    let id = floor(px / cs);
    var sum = 0.0;
    for (var y = 0; y < 3; y++) {
      for (var x = 0; x < 3; x++) { sum += luma(scene((id + (vec2f(f32(x), f32(y)) + 0.5) / 3.0) * cs / size)); }
    }
    let lum = min(sum / 9.0 * 1.4, 1.0);
    let ramp = array(32u, 46u, 58u, 45u, 61u, 43u, 42u, 35u, 37u, 64u);
    let ch = ramp[min(u32(pow(lum, 0.7) * 10.0), 9u)];
    let at = vec2u(px - id * cs);
    let ink = textureLoad(atlas, vec2u((ch % 16u) * 10u, ((ch - 32u) / 16u) * 18u) + at, 0).r;
    return vec3f(ink) * mix(vec3f(0.85, 0.92, 1.0), heat(lum), 0.35) * min(lum * 3.0 + 0.2, 1.0);
  }
  if (mode == 2) {
    // Halftone at 45 degrees: one dot per cell, its area the cell's light.
    let r = mat2x2f(0.7071, -0.7071, 0.7071, 0.7071);
    let q = r * px;
    let id = floor(q / cell);
    let centre = (id + 0.5) * cell;
    let lum = luma(scene((transpose(r) * centre) / size));
    let rad = sqrt(lum) * cell * 0.62;
    return vec3f(smoothstep(rad + 0.7, rad - 0.7, length(q - centre)));
  }
  if (mode == 3) {
    // One bit: ordered dither, steel and black.
    return vec3f(step(bayer(vec2u(px / 2.0)), pow(luma(c), 0.8))) * vec3f(0.88, 0.93, 1.0);
  }
  if (mode == 4) { return heat(pow(luma(c), 0.6) * 1.15); }
  if (mode == 5) {
    // Contours of light, like a height map.
    let lum = luma(c);
    return vec3f(1.0, 0.24, 0.06) * step(0.86, fract(lum * 12.0)) * step(0.02, lum) + c * 0.15;
  }
  if (mode == 6) { return scene((floor(px / cell) + 0.5) * cell / size); }
  if (mode == 7) { return vec3f(1.0) - c; }
  return c;
}

@fragment fn lookFs(i: V) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  var uv = i.uv;
  var px = i.pos.xy;
  // Glitch: rows thrown sideways, and some of those sorted (smeared to their brightest neighbour).
  var sorted = false;
  if (u.b.x > 0.0) {
    let rowH = 6.0 + 42.0 * rowHash(floor(px.y / 48.0), u.a.w + 3.0);
    let row = floor(px.y / rowH);
    if (rowHash(row, u.a.w) < u.b.x) {
      uv.x = fract(uv.x + (rowHash(row, u.a.w + 1.0) - 0.5) * u.b.z);
      px.x = uv.x * size.x;
      sorted = rowHash(row, u.a.w + 2.0) < u.b.y;
    }
  }
  var c = scene(uv);
  if (sorted) {
    for (var k = 1; k <= 24; k++) { c = max(c, scene(uv - vec2f(f32(k * k) * 0.6 / size.x, 0.0)) * (1.0 - f32(k) / 26.0)); }
  }
  if (u.a.y > 0.0) { c = mix(c, look(uv, px, c), u.a.y); }
  let q = i.uv - 0.5;
  c *= 1.0 - u.c.x * dot(q, q) * 1.6;
  c += (hash(vec3f(i.pos.xy, u.a.w)) - 0.5) * u.c.y;
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`
