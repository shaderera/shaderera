// The row glitch: one invocation per line (a row, or a column). The line's band is hit or not by a
// hash of the seed; a hit band is thrown sideways (wrapping) and may be pixel sorted: each run of
// pixels whose brightness is within the range is sorted by brightness, a stable counting sort over
// 256 steps, and the pixels outside the range stay where they are. Values are moved, never changed.

export const ROW_GLITCH_WGSL = /* wgsl */ `
struct Glitch {
  a: vec4f,  // share of bands hit, throw (share of the line), share of hit bands sorted, seed
  b: vec4f,  // band height min, max (px), brightness range low, high (0–1)
  c: vec4f,  // order (0 dark first, 1 bright first), axis (0 rows, 1 columns), 0, 0
}

@group(0) @binding(0) var<uniform> u: Glitch;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

fn hash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn coord(line: u32, i: u32) -> vec2u { return select(vec2u(i, line), vec2u(line, i), u.c.y > 0.5); }

// Pixel i of the line once the band is thrown by offset px, wrapping round.
fn at(line: u32, i: u32, len: u32, offset: u32) -> vec4f {
  return textureLoad(src, coord(line, (i + len - offset) % len), 0);
}

fn luma(c: vec4f) -> f32 { return dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)); }

fn inRange(c: vec4f) -> bool {
  let l = luma(c);
  return l >= u.b.z && l <= u.b.w;
}

fn bin(c: vec4f) -> u32 {
  let b = u32(clamp(luma(c), 0.0, 1.0) * 255.0 + 0.5);
  return select(b, 255u - b, u.c.x > 0.5);
}

@compute @workgroup_size(64) fn glitchCs(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(src);
  let cols = u.c.y > 0.5;
  let len = select(size.x, size.y, cols);
  let line = id.x;
  if (line >= select(size.y, size.x, cols)) { return; }

  // Bands: blocks of the largest height, each cut into bands of one height between the two.
  let tall = max(u.b.y, 1.0);
  let block = floor(f32(line) / tall);
  let h = max(mix(u.b.x, tall, hash(vec3f(block, u.a.w, 1.0))), 1.0);
  let band = block * 4096.0 + floor((f32(line) - block * tall) / h);
  var offset = 0u;
  var sorted = false;
  if (hash(vec3f(band, u.a.w, 2.0)) < u.a.x) {
    let shift = i32(round((hash(vec3f(band, u.a.w, 3.0)) * 2.0 - 1.0) * u.a.y * f32(len)));
    offset = u32((shift % i32(len) + i32(len)) % i32(len));
    sorted = hash(vec3f(band, u.a.w, 4.0)) < u.a.z;
  }

  if (!sorted) {
    for (var i = 0u; i < len; i++) { textureStore(dst, coord(line, i), at(line, i, len, offset)); }
    return;
  }
  var counts: array<u32, 256>;
  var i = 0u;
  loop {
    if (i >= len) { break; }
    let c = at(line, i, len, offset);
    if (!inRange(c)) {
      textureStore(dst, coord(line, i), c);
      i++;
      continue;
    }
    // A run: from i to the first pixel out of range.
    var end = i + 1u;
    loop {
      if (end >= len || !inRange(at(line, end, len, offset))) { break; }
      end++;
    }
    for (var k = i; k < end; k++) { counts[bin(at(line, k, len, offset))] += 1u; }
    var start = 0u;
    for (var b = 0u; b < 256u; b++) {
      let n = counts[b];
      counts[b] = start;
      start += n;
    }
    for (var k = i; k < end; k++) {
      let p = at(line, k, len, offset);
      let b = bin(p);
      textureStore(dst, coord(line, i + counts[b]), p);
      counts[b] += 1u;
    }
    for (var b = 0u; b < 256u; b++) { counts[b] = 0u; }
    i = end;
  }
}
`
