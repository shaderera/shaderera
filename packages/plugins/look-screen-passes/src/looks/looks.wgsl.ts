// The looks pass: the same frame in another medium. It reads a finished frame (display values,
// 0–1) and writes one, opaque. Brightness is Rec. 709 luma of the display values, through `gamma`.

export const LOOKS_WGSL = /* wgsl */ `
struct Look {
  a: vec4f,  // mode (0 ascii, 1 halftone, 2 dither, 3 heat, 4 contours, 5 pixels, 6 inverse), amount, cell px, gamma
  b: vec4f,  // ink rgb, 1 if the ink is the frame's own colour
  c: vec4f,  // paper rgb, halftone angle (rad)
  d: vec4f,  // dither levels, contour bands, contour line width px, frame under the contours
  e: vec4f,  // ascii glyphs in the ramp, ascii cell height px, heat palette stops, 0
  palette: array<vec4f, 8>,
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

fn scene(uv: vec2f) -> vec3f { return textureSampleLevel(src, lin, uv, 0.0).rgb; }

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn tone(c: vec3f) -> f32 { return pow(clamp(luma(c), 0.0, 1.0), u.a.w); }

fn ink(own: vec3f) -> vec3f { return select(u.b.rgb, own, u.b.w > 0.5); }

fn paper() -> vec3f { return u.c.rgb; }

// The mean colour of a w x h px box with its top left at p0: an even grid of up to 8 x 8 bilinear
// taps, each the mean of four texels.
fn boxMean(p0: vec2f, w: f32, h: f32) -> vec3f {
  let size = vec2f(textureDimensions(src));
  let n = vec2f(clamp(ceil(w * 0.5), 1.0, 8.0), clamp(ceil(h * 0.5), 1.0, 8.0));
  var sum = vec3f(0.0);
  for (var y = 0.0; y < n.y; y += 1.0) {
    for (var x = 0.0; x < n.x; x += 1.0) {
      sum += scene((p0 + (vec2f(x, y) + 0.5) / n * vec2f(w, h)) / size);
    }
  }
  return sum / (n.x * n.y);
}

// The 8 x 8 Bayer matrix: each bit of x and y, lowest first, is a base-4 digit, highest first.
fn bayer(p: vec2u) -> f32 {
  var v = 0u;
  for (var k = 0u; k < 3u; k++) {
    let x = (p.x >> k) & 1u;
    let y = (p.y >> k) & 1u;
    v += (((x ^ y) << 1u) | y) << (2u * (2u - k));
  }
  return (f32(v) + 0.5) / 64.0;
}

fn heat(t0: f32) -> vec3f {
  let n = max(u32(u.e.z), 2u);
  let t = clamp(t0, 0.0, 1.0) * f32(n - 1u);
  let i = min(u32(t), n - 2u);
  return mix(u.palette[i].rgb, u.palette[i + 1u].rgb, t - f32(i));
}

fn look(uv: vec2f, px: vec2f, c: vec3f) -> vec3f {
  let mode = i32(u.a.x + 0.5);
  let size = vec2f(textureDimensions(src));
  let cell = max(u.a.z, 1.0);
  if (mode == 0) {
    // ASCII: each cell is the ramp's glyph for the cell's mean brightness, scaled from the atlas.
    let cs = vec2f(cell, max(u.e.y, 1.0));
    let id = floor(px / cs);
    let mean = boxMean(id * cs, cs.x, cs.y);
    let n = max(u.e.x, 1.0);
    let g = min(floor(tone(mean) * n), n - 1.0);
    let local = (px - id * cs) / cs;
    let a = vec2f(textureDimensions(atlas));
    let slot = vec2f(a.x / n, a.y);
    let lod = max(log2(slot.x / cs.x), 0.0);
    let glyph = textureSampleLevel(atlas, lin, (vec2f(g, 0.0) + local) * slot / a, lod).r;
    return mix(paper(), ink(mean), glyph);
  }
  if (mode == 1) {
    // Halftone: one dot per cell on a grid turned by the angle, its area the cell's brightness.
    let s = sin(u.c.w);
    let k = cos(u.c.w);
    let q = vec2f(k * px.x + s * px.y, -s * px.x + k * px.y);
    let id = floor(q / cell);
    let centre = (id + 0.5) * cell;
    let back = vec2f(k * centre.x - s * centre.y, s * centre.x + k * centre.y);
    let mean = boxMean(back - cell * 0.5, cell, cell);
    let rad = sqrt(tone(mean) / 3.14159265) * cell;
    let dot = smoothstep(rad + 0.7, rad - 0.7, length(q - centre));
    return mix(paper(), ink(mean), dot);
  }
  if (mode == 2) {
    // Ordered dither to a number of levels, in cell-px blocks: the brightness between paper and
    // ink, or each channel of the frame's own colour.
    let p = floor(px / cell);
    let threshold = bayer(vec2u(p));
    let l = max(u.d.x, 2.0) - 1.0;
    let at = (p + 0.5) * cell / size;
    let own = scene(at);
    if (u.b.w > 0.5) {
      return floor(pow(clamp(own, vec3f(0.0), vec3f(1.0)), vec3f(u.a.w)) * l + threshold) / l;
    }
    return mix(paper(), u.b.rgb, floor(tone(own) * l + threshold) / l);
  }
  if (mode == 3) { return heat(tone(c)); }
  if (mode == 4) {
    // Contours: a line line-px wide where the brightness crosses each of the bands' steps (not at
    // 0 or 1): its distance to the step over how fast it changes, so flat areas stay clear.
    // Read from a 4 x 4 px mean, so 8-bit steps in a smooth gradient do not break the lines.
    let v = tone(boxMean(px - 2.0, 4.0, 4.0)) * u.d.y;
    let d = abs(fract(v + 0.5) - 0.5) / max(fwidth(v), 0.0001);
    let step = round(v);
    let on = clamp(u.d.z * 0.5 + 0.5 - d, 0.0, 1.0) * select(0.0, 1.0, step > 0.0 && step < u.d.y);
    return mix(mix(paper(), c, u.d.w), ink(c), on);
  }
  if (mode == 5) {
    let id = floor(px / cell);
    return boxMean(id * cell, cell, cell);
  }
  return vec3f(1.0) - c;
}

@fragment fn lookFs(i: V) -> @location(0) vec4f {
  let c = scene(i.uv);
  return vec4f(clamp(mix(c, look(i.uv, i.pos.xy, c), u.a.y), vec3f(0.0), vec3f(1.0)), 1.0);
}
`
