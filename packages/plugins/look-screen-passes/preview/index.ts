// look-screen-passes: one luminous procedural source on black, 150 000 points that morph from a
// breathing sphere to a (2,3) torus knot to a sheet of travelling waves while the cloud turns,
// and the plugin's pass over it, changing medium every 0.75 s. Each new pass wipes over the last
// one, so the same frame is seen crossing from one medium to the next. The pass is the big word
// top left, the form bottom right, in the house style (house.ts) over the passes.

import { createHouse, type Word } from '../../previews/src/house.ts'
import { createLooks, type LookName, type LookParams } from '../../previews/src/looks/looks.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

type Segment = { id: string; look: LookName; word: string; note: string; params?: LookParams }

/** The passes in order, one per 0.75 s; the first follows the last, so the loop has no seam. */
const SEGMENTS: Segment[] = [
  { id: 'source', look: 'none', word: 'SOURCE', note: 'the points, before any pass' },
  { id: 'ascii', look: 'ascii', word: 'ASCII', note: 'a glyph a cell, by its brightness' },
  {
    id: 'halftone',
    look: 'halftone',
    word: 'HALFTONE',
    note: 'dots as big as the light under them',
    params: { cell: 18 },
  },
  { id: 'dither', look: 'dither', word: 'DITHER', note: 'an ordered threshold, one bit deep' },
  { id: 'heat', look: 'heat', word: 'HEAT', note: 'brightness as a thermal palette' },
  { id: 'contours', look: 'contours', word: 'CONTOURS', note: 'lines where the light crosses' },
  {
    id: 'pixels',
    look: 'pixels',
    word: 'PIXELS',
    note: 'blocks of 27 px, each its mean',
    params: { cell: 27 },
  },
  {
    id: 'glitch',
    look: 'none',
    word: 'GLITCH',
    note: 'rows thrown sideways, some sorted',
    params: { glitch: 0.34, sort: 0.6, throw: 0.2 },
  },
]
const STEP = 0.75
const WIPE = 0.22
const POINTS = 150_000
/** The form bottom right: each changes half way through the cloud's flight to the next. */
const FORMS: Word[] = [
  { from: 0, to: 1.5, text: 'SPHERE' },
  { from: 1.5, to: 3.5, text: 'KNOT' },
  { from: 3.5, to: 5.5, text: 'WAVES' },
  { from: 5.5, to: 6, text: 'SPHERE' },
]

const POINTS_WGSL = /* wgsl */ `
struct U { a: vec4f, b: vec4f }  // a: t, loop phase, kick, 0; b: centre y (clip), point px, gain, 0
@group(0) @binding(0) var<uniform> u: U;

const TAU = 6.2831853;

fn hash(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}
fn rotY(p: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }
fn rotX(p: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }

// Three forms of the same points; every motion is a whole number of turns a loop, so t = 6 is t = 0.
fn sphere(r: vec3f, ph: f32) -> vec3f {
  let z = r.x * 2.0 - 1.0;
  let a = r.y * TAU;
  let d = vec3f(sqrt(1.0 - z * z) * cos(a), z, sqrt(1.0 - z * z) * sin(a));
  let wave = sin(d.x * 4.0 + ph * TAU * 2.0) * sin(d.y * 3.0 - ph * TAU) * sin(d.z * 5.0 + ph * TAU * 3.0);
  return d * (1.0 + 0.3 * wave + 0.05 * (r.z - 0.5)) * 1.02;
}
fn knotAt(s: f32) -> vec3f {
  return vec3f((2.0 + cos(3.0 * s)) * cos(2.0 * s), sin(3.0 * s), (2.0 + cos(3.0 * s)) * sin(2.0 * s)) * 0.37;
}
fn knot(r: vec3f, ph: f32) -> vec3f {
  let s = r.x * TAU;
  let c = knotAt(s);
  let tangent = normalize(knotAt(s + 0.002) - c);
  let n = normalize(cross(tangent, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-4));
  let b = cross(tangent, n);
  // The skin slides round the tube, and beads of it travel along the knot.
  let a = r.y * TAU + ph * TAU * 2.0;
  let radius = 0.16 * sqrt(r.z) * (1.0 + 0.45 * sin(s * 14.0 - ph * TAU * 5.0));
  return c + (n * cos(a) + b * sin(a)) * radius;
}
fn waves(r: vec3f, ph: f32) -> vec3f {
  let x = r.x * 2.0 - 1.0;
  let z = r.y * 2.0 - 1.0;
  let h = sin(x * 5.0 + ph * TAU * 2.0) * 0.2
    + sin(z * 4.0 - ph * TAU * 3.0 + x * 2.0) * 0.15
    + sin(length(vec2f(x, z)) * 10.0 - ph * TAU * 4.0) * 0.08;
  return vec3f(x * 1.15, h + (r.z - 0.5) * 0.03, z * 1.15);
}
fn form(k: u32, r: vec3f, ph: f32) -> vec3f {
  if (k == 0u) { return sphere(r, ph); }
  if (k == 1u) { return knot(r, ph); }
  return waves(r, ph);
}

struct V { @builtin(position) pos: vec4f, @location(0) corner: vec2f, @location(1) light: f32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) id: u32) -> V {
  let r = vec3f(hash(id * 3u), hash(id * 3u + 1u), hash(id * 3u + 2u));
  let ph = u.a.y;
  let T = ph * TAU;
  // Two seconds a form: the cloud holds, then flies to the next in the second half, each point
  // leaving at its own moment and swirling on the way.
  let m = ph * 3.0;
  let k = u32(floor(m)) % 3u;
  let delay = hash(id * 7u + 5u) * 0.25;
  let f = smoothstep(0.5 + delay, 0.75 + delay, fract(m));
  var p = mix(form(k, r, ph), form((k + 1u) % 3u, r, ph), f);
  p += vec3f(sin(p.y * 3.1 + T * 2.0), sin(p.z * 2.7 - T * 3.0), sin(p.x * 3.3 + T)) * 0.4 * sin(f * 3.14159);
  p *= 1.0 + 0.09 * u.a.z;
  p = rotX(rotY(p, T + 0.4), 0.62 + 0.12 * sin(T));

  let dist = 3.6 - p.z;
  let spark = select(1.0, 2.6, hash(id * 11u + 3u) < 0.025);
  let px = u.b.y * spark * 3.6 / dist;
  var corners = array(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  var o: V;
  o.pos = vec4f(p.x * 1.9, p.y * 1.9 + u.b.x * dist, 0.5 * dist, dist);
  o.pos = vec4f(o.pos.xy + c * px * (2.0 / 1080.0) * dist, o.pos.zw);
  o.corner = c;
  o.light = u.b.z * spark * mix(1.0, 0.3, clamp((dist - 2.4) / 2.4, 0.0, 1.0));
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let a = exp(-dot(i.corner, i.corner) * 3.0) * i.light;
  return vec4f(vec3f(0.92, 0.96, 1.0) * a, 0.0);
}
`

const WIPE_WGSL = /* wgsl */ `
struct U { a: vec4f }  // progress 0-1, direction 0-3, line px, 0
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var texA: texture_2d<f32>;
@group(0) @binding(2) var texB: texture_2d<f32>;
struct V { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(texB));
  let px = vec2i(i.pos.xy);
  let uv = i.pos.xy / size;
  let d = u32(u.a.y);
  var s: f32;
  var len: f32;
  if (d == 0u) { s = uv.y; len = size.y; } else if (d == 1u) { s = uv.x; len = size.x; }
  else if (d == 2u) { s = 1.0 - uv.y; len = size.y; } else { s = 1.0 - uv.x; len = size.x; }
  let edge = u.a.x;
  var c = select(textureLoad(texA, px, 0), textureLoad(texB, px, 0), s < edge);
  if (abs(s - edge) * len < u.a.z && edge > 0.0 && edge < 1.0) { c = vec4f(1.0); }
  return vec4f(c.rgb, 1.0);
}
`

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

const lookScreenPasses: OpenPreview = async (host, stateId) => {
  // 'all' cycles through every pass; a state holds one ('off' is the source with no pass).
  const segments =
    stateId === 'all'
      ? SEGMENTS
      : SEGMENTS.filter((s) => s.id === (stateId === 'off' ? 'source' : stateId))
  if (segments.length === 0) throw new Error(`look-screen-passes has no state "${stateId}"`)
  const first = segments[0] as Segment
  const device = host.gpu
  if (!device) throw new Error('The look-screen-passes preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const looks = createLooks(host, { width, height, face: FONT.mono })
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  // The pass is the big word top left, with its note; a held pass keeps its word all loop.
  const passWords: Word[] = segments.map((s, i) => ({
    from: segments.length > 1 ? i * STEP : 0,
    to: segments.length > 1 ? (i + 1) * STEP : duration,
    text: s.word,
  }))
  const passNotes: Word[] = segments.map((s, i) => ({ ...(passWords[i] as Word), text: s.note }))

  const format: GPUTextureFormat = 'rgba8unorm'
  const texture = (usage: number) => device.createTexture({ size: [width, height], format, usage })
  const scene = texture(GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING)
  const held = texture(GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING)
  const wiped = texture(GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING)

  const pipelineOf = (code: string, blend?: GPUBlendState) => {
    const module = device.createShaderModule({ code })
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format, ...(blend ? { blend } : {}) }] },
      primitive: { topology: 'triangle-list' },
    })
  }
  // The points add up: where the cloud is dense it burns white, so every pass has a range to read.
  const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
  const pointsPipe = pipelineOf(POINTS_WGSL, { color: add, alpha: add })
  const wipePipe = pipelineOf(WIPE_WGSL)
  const pointsU = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const wipeU = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const pointsGroup = device.createBindGroup({
    layout: pointsPipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: pointsU } }],
  })
  let wipeGroup: GPUBindGroup | undefined
  const draw = (
    pipe: GPURenderPipeline,
    group: GPUBindGroup,
    target: GPUTexture,
    vertices: number,
    instances = 1,
  ) => {
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, group)
    pass.draw(vertices, instances)
    pass.end()
    device.queue.submit([encoder.finish()])
  }

  const state = (t: number) => {
    const n = Math.floor(t / STEP)
    const since = t - n * STEP
    const segment = segments[n % segments.length] ?? first
    const before = segments[(n + segments.length - 1) % segments.length] ?? first
    // One pass: no wipe, only the kick (and a short glitch on it, unless the pass is off).
    const wipe = since < WIPE && segments.length > 1 ? easeInOut(since / WIPE) : 1
    return {
      segment: n % segments.length,
      look: segment,
      before,
      wipe,
      direction: n % 4,
      kick: Math.exp(-since / 0.16),
    }
  }
  const lookParams = (s: Segment, frame: number, extra: number): LookParams => ({
    look: s.look,
    ...s.params,
    glitch: Math.min(0.6, (s.params?.glitch ?? 0) + extra),
    grain: 0,
    vignette: 0.35,
    seed: frame,
  })
  const overlay = (t: number, frame: number, s: ReturnType<typeof state>) => {
    ctx.clearRect(0, 0, width, height)
    house.index()
    house.words(passWords, FORMS, t, frame)
    house.notes(passNotes, t, frame)
    const look = s.look.look === 'none' ? (s.look.params?.glitch ? 'ROW GLITCH' : 'NONE') : ''
    house.hud(
      t,
      frame,
      `PASS ${look || s.look.look.toUpperCase()}   ONE WGSL DRAW`,
      `${POINTS.toLocaleString('en-US')} POINTS`,
    )
    return canvas
  }
  const pictureOf = (t: number, frame: number, s: ReturnType<typeof state>): GPUTexture => {
    // The picture's centre (452 px down, above the caption band) in clip space, the point's size
    // in px, and how much light each point adds.
    device.queue.writeBuffer(
      pointsU,
      0,
      new Float32Array([t, t / duration, s.kick, 0, 1 - (2 * 452) / height, 1.8, 0.28, 0]),
    )
    draw(pointsPipe, pointsGroup, scene, 6, POINTS)
    const burst = s.wipe < 1 ? 0.22 * (1 - s.wipe) : 0
    if (s.wipe >= 1) {
      const hit = segments.length === 1 && s.look.id !== 'source' && s.kick > 0.6 ? 0.12 : 0
      return looks.apply(scene, lookParams(s.look, frame, hit))
    }
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToTexture(
      { texture: looks.apply(scene, lookParams(s.before, frame, burst)) },
      { texture: held },
      [width, height],
    )
    device.queue.submit([encoder.finish()])
    const to = looks.apply(scene, lookParams(s.look, frame, burst))
    wipeGroup ??= device.createBindGroup({
      layout: wipePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: wipeU } },
        { binding: 1, resource: held.createView() },
        { binding: 2, resource: to.createView() },
      ],
    })
    device.queue.writeBuffer(wipeU, 0, new Float32Array([s.wipe, s.direction, 2, 0]))
    draw(wipePipe, wipeGroup, wiped, 3)
    return wiped
  }

  return {
    async render(t, o) {
      const s = state(t)
      return [
        { color: pictureOf(t, o.frame, s), alpha: 'opaque' },
        { color: overlay(t, o.frame, s), name: 'house' },
      ]
    },
    status(t) {
      const s = state(t)
      if (segments.length === 1) return s.look.id === 'source' ? 'pass off' : s.look.id
      return `${String(s.segment + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${s.look.id}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'looks', look: s.look.id, from: s.before.id, wipe: s.wipe, kick: s.kick }
    },
  }
}

export default lookScreenPasses
