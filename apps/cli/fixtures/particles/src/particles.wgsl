// Seeded particles in a flow field, stepped once per frame, drawn as trails that fade.
// Every input is the frame's: `frame` and `dt` come from the host's frame index, never a clock.

struct Particle { pos: vec2f, vel: vec2f }
struct Uniforms { frame: f32, dt: f32, aspect: f32, trail: f32 }

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> before: array<Particle>;
@group(0) @binding(2) var<storage, read_write> after: array<Particle>;

// A divergence-free field: the curl of a sum of sines that drift slowly with time.
fn potential(p: vec2f, t: f32) -> f32 {
  return sin(p.x * 3.1 + t * 0.21) * cos(p.y * 2.7 - t * 0.17)
    + 0.5 * sin(p.x * 5.3 - p.y * 4.1 + t * 0.33)
    + 0.25 * cos(p.x * 9.7 + p.y * 8.9 - t * 0.5);
}

fn flow(p: vec2f, t: f32) -> vec2f {
  let e = 0.002;
  let dx = potential(p + vec2f(e, 0.0), t) - potential(p - vec2f(e, 0.0), t);
  let dy = potential(p + vec2f(0.0, e), t) - potential(p - vec2f(0.0, e), t);
  return vec2f(dy, -dx) / (2.0 * e);
}

@compute @workgroup_size(256)
fn advance(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&before)) { return; }
  var q = before[i];
  let t = u.frame * u.dt;
  // The field is evaluated in square units; the frame stretches x by the aspect ratio.
  let v = flow(vec2f(q.pos.x * u.aspect, q.pos.y), t) * 0.35;
  q.vel = mix(q.vel, vec2f(v.x / u.aspect, v.y), 0.08);
  q.pos = q.pos + q.vel * u.dt;
  // Wrap inside [-1, 1] so the field stays filled.
  q.pos = (fract((q.pos + 1.0) * 0.5) * 2.0) - 1.0;
  after[i] = q;
}

// The trail: last frame's light, faded. A fullscreen triangle.
struct Full { @builtin(position) pos: vec4f }

@vertex
fn full(@builtin(vertex_index) i: u32) -> Full {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Full(vec4f(xy, 0.0, 1.0));
}

@group(0) @binding(3) var previous: texture_2d<f32>;

@fragment
fn fade(f: Full) -> @location(0) vec4f {
  return textureLoad(previous, vec2i(f.pos.xy), 0) * u.trail;
}

// The particles: one point each, added on top of the trail. The stepped buffer, read-only here
// (a vertex stage cannot bind read_write storage).
@group(0) @binding(5) var<storage, read> drawn: array<Particle>;

struct Dot { @builtin(position) pos: vec4f, @location(0) light: vec3f }

@vertex
fn point(@builtin(vertex_index) i: u32) -> Dot {
  let q = drawn[i];
  let speed = clamp(length(q.vel) * 2.2, 0.0, 1.0);
  // Slow particles glow deep blue, fast ones warm white.
  let light = mix(vec3f(0.05, 0.12, 0.45), vec3f(1.0, 0.72, 0.42), speed) * 0.09;
  return Dot(vec4f(q.pos, 0.0, 1.0), light);
}

@fragment
fn glow(d: Dot) -> @location(0) vec4f {
  return vec4f(d.light, 1.0);
}

// To the frame: filmic exposure of the accumulated light.
@group(0) @binding(4) var accum: texture_2d<f32>;

@fragment
fn expose(f: Full) -> @location(0) vec4f {
  let light = textureLoad(accum, vec2i(f.pos.xy), 0).rgb;
  let c = vec3f(1.0) - exp(-light * 1.6);
  return vec4f(pow(c, vec3f(1.0 / 2.2)), 1.0);
}
