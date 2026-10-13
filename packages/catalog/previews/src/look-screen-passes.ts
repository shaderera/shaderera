// look-screen-passes: one procedural source, a raymarched form that morphs from a gyroid blob to a
// lattice sphere to a twisted torus while the camera circles it, and the item's pass over it,
// changing medium every 0.75 s. Each new pass wipes over the last one, so the same frame is seen
// crossing from one medium to the next.

import { createLooks, type LookName, type LookParams } from './looks/looks.ts'
import { FONT, type OpenPreview } from './preview.ts'

/** The passes in order, one per 0.75 s; the first follows the last, so the loop has no seam. */
const SEGMENTS: { id: string; look: LookName; label: string; params?: LookParams }[] = [
  { id: 'source', look: 'none', label: 'source' },
  { id: 'ascii', look: 'ascii', label: 'ascii' },
  { id: 'halftone', look: 'halftone', label: 'halftone', params: { cell: 18 } },
  { id: 'dither', look: 'dither', label: 'dither' },
  { id: 'heat', look: 'heat', label: 'heat' },
  { id: 'contours', look: 'contours', label: 'contours' },
  { id: 'pixels', look: 'pixels', label: 'pixels', params: { cell: 27 } },
  {
    id: 'glitch',
    look: 'inverse',
    label: 'inverse + glitch',
    params: { glitch: 0.34, sort: 0.6, throw: 0.2 },
  },
]
const STEP = 0.75
const WIPE = 0.22

const SCENE_WGSL = /* wgsl */ `
struct U { a: vec4f, b: vec4f }  // a: t, loop phase, kick, aspect; b: unused
@group(0) @binding(0) var<uniform> u: U;

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

const TAU = 6.2831853;

fn rot(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn gyroid(p: vec3f) -> f32 { return dot(sin(p), cos(p.yzx)); }
fn smin(a: f32, b: f32, k: f32) -> f32 { let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// Three forms; every motion is a whole number of turns per loop, so t = 6 is t = 0.
fn blob(p: vec3f, ph: f32) -> f32 {
  let g = gyroid(p * 3.2 + vec3f(0.0, ph * TAU, 0.0));
  return (length(p) - 1.0 + 0.16 * g) * 0.7;
}
fn lattice(p: vec3f, ph: f32) -> f32 {
  let shell = length(p) - 1.08;
  let q = p * 5.0;
  let g = (abs(gyroid(q + vec3f(ph * TAU))) - 0.32) / 5.0 * 0.8;
  return max(shell, g);
}
fn torus(p0: vec3f, ph: f32) -> f32 {
  // Tilted toward the camera, and rocking, so the twist reads from every side.
  var p = p0;
  p = vec3f(p.x, rot(1.0 + 0.3 * sin(ph * TAU * 2.0)) * p.yz);
  let a = atan2(p.z, p.x);
  let r = vec2f(length(p.xz) - 0.82, p.y);
  let tw = rot(a * 2.0 + ph * TAU) * r;
  let box = abs(tw) - vec2f(0.3, 0.1);
  return (length(max(box, vec2f(0.0))) + min(max(box.x, box.y), 0.0) - 0.05) * 0.55;
}

fn form(p: vec3f) -> f32 {
  let ph = u.a.y;
  let m = ph * 3.0;
  let i = u32(floor(m)) % 3u;
  let f = smoothstep(0.55, 1.0, fract(m));
  var d0: f32; var d1: f32;
  let q = p / (1.0 + 0.07 * u.a.z);
  if (i == 0u) { d0 = blob(q, ph); d1 = lattice(q, ph); }
  else if (i == 1u) { d0 = lattice(q, ph); d1 = torus(q, ph); }
  else { d0 = torus(q, ph); d1 = blob(q, ph); }
  return mix(d0, d1, f) * (1.0 + 0.07 * u.a.z);
}

// A ring of satellites that turns twice a loop.
fn moons(p0: vec3f) -> f32 {
  var p = p0;
  p = vec3f(p.x, (rot(0.45) * p.yz));
  let a = atan2(p.z, p.x) - u.a.y * TAU * 2.0;
  let n = 14.0;
  let k = (floor(a / TAU * n) + 0.5) / n * TAU;
  let c = vec3f(cos(k + u.a.y * TAU * 2.0), 0.0, sin(k + u.a.y * TAU * 2.0)) * 1.75;
  let s = 0.06 + 0.035 * sin(k * 3.0 + u.a.y * TAU * 4.0);
  return length(p - c) - s;
}

fn map(p: vec3f) -> vec2f {
  let a = form(p);
  let b = moons(p);
  if (a < b) { return vec2f(a, 0.0); }
  return vec2f(b, 1.0);
}

fn normal(p: vec3f) -> vec3f {
  let e = vec2f(0.0015, 0.0);
  return normalize(vec3f(
    map(p + e.xyy).x - map(p - e.xyy).x,
    map(p + e.yxy).x - map(p - e.yxy).x,
    map(p + e.yyx).x - map(p - e.yyx).x));
}

fn occlusion(p: vec3f, n: vec3f) -> f32 {
  var o = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 5; i++) {
    let h = 0.04 * f32(i);
    o += (h - map(p + n * h).x) * w;
    w *= 0.7;
  }
  return clamp(1.0 - 3.0 * o, 0.0, 1.0);
}

@fragment fn fs(i: V) -> @location(0) vec4f {
  let ph = u.a.y;
  // Centred on the picture above the caption band (the top 904 px).
  let uv = (i.uv - 0.5) * vec2f(1.0, -1.0) * 2.0 - vec2f(0.0, 0.16);
  let orbit = ph * TAU;
  let dist = 3.85 - 0.3 * u.a.z;
  let eye = vec3f(sin(orbit) * dist, 0.55 + 0.35 * sin(orbit * 2.0), cos(orbit) * dist);
  let fw = normalize(-eye);
  let rt = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(rt, fw);
  let rd = normalize(fw * 1.75 + rt * uv.x + up * uv.y);

  // The ground: a dark plane with a fine grid, so the passes have lines to work on.
  var col = vec3f(0.0);
  // The floor's grid coordinates, and their footprint, in uniform control flow (fwidth needs it).
  let floorY = -1.55;
  let tf = (floorY - eye.y) / min(rd.y, -1e-4);
  let gp = (eye + rd * tf).xz * 2.0;
  let gw = fwidth(gp);
  var t = 0.0;
  var hit = -1.0;
  for (var s = 0; s < 110; s++) {
    let h = map(eye + rd * t);
    if (h.x < 0.0008 * t) { hit = h.y; break; }
    t += h.x;
    if (t > 12.0) { break; }
  }
  if (rd.y < 0.0 && (hit < 0.0 || tf < t)) {
    let p = eye + rd * tf;
    let g = abs(fract(gp + 0.5) - 0.5) / gw;
    let line = 1.0 - min(min(g.x, g.y), 1.0);
    let fade = exp(-0.11 * tf * tf);
    let shadow = smoothstep(0.0, 1.6, length(p.xz));
    col += vec3f(0.55) * line * fade * (0.3 + 0.7 * shadow);
  } else if (hit >= 0.0) {
    let p = eye + rd * t;
    let n = normal(p);
    let key = normalize(vec3f(0.6, 0.85, 0.35));
    let back = normalize(vec3f(-0.7, 0.2, -0.6));
    let dif = max(dot(n, key), 0.0);
    let spec = pow(max(dot(reflect(rd, n), key), 0.0), 40.0);
    let fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let rim = pow(max(dot(n, back), 0.0), 2.0);
    let ao = occlusion(p, n);
    let base = select(vec3f(0.9, 0.92, 0.95), vec3f(1.0), hit > 0.5);
    // Scan lines of light that climb the form four times a loop.
    let scan = pow(0.5 + 0.5 * sin(p.y * 9.0 + 2.0 * sin(p.x * 1.7) - ph * TAU * 4.0), 18.0);
    col = base * (0.04 + 1.0 * dif) * ao
      + vec3f(1.0) * scan * 0.9 * select(1.0, 0.0, hit > 0.5)
      + vec3f(1.0) * spec * 1.2
      + vec3f(1.0, 0.24, 0.08) * rim * (1.1 + 0.8 * u.a.z)
      + vec3f(0.35, 0.45, 0.6) * fres * 0.5 * ao;
    col = mix(col, vec3f(0.02), 1.0 - exp(-0.02 * t * t));
  }
  col = col / (1.0 + col * 0.35);
  col = pow(col, vec3f(1.0 / 1.15));
  return vec4f(col, 1.0);
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
  const first = segments[0] as (typeof SEGMENTS)[number]
  const device = host.gpu
  if (!device) throw new Error('The look-screen-passes preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const looks = createLooks(host, { width, height, face: FONT.mono })
  const format: GPUTextureFormat = 'rgba8unorm'
  const texture = (usage: number) => device.createTexture({ size: [width, height], format, usage })
  const scene = texture(GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING)
  const held = texture(GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING)
  const wiped = texture(GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING)

  const pipelineOf = (code: string) => {
    const module = device.createShaderModule({ code })
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
  }
  const scenePipe = pipelineOf(SCENE_WGSL)
  const wipePipe = pipelineOf(WIPE_WGSL)
  const sceneU = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const wipeU = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const sceneGroup = device.createBindGroup({
    layout: scenePipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: sceneU } }],
  })
  let wipeGroup: GPUBindGroup | undefined
  const draw = (pipe: GPURenderPipeline, group: GPUBindGroup, target: GPUTexture) => {
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    })
    pass.setPipeline(pipe)
    pass.setBindGroup(0, group)
    pass.draw(3)
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
  const lookParams = (s: (typeof SEGMENTS)[number], frame: number, extra: number): LookParams => ({
    look: s.look,
    ...s.params,
    glitch: Math.min(0.6, (s.params?.glitch ?? 0) + extra),
    grain: 0.035,
    vignette: 0.35,
    seed: frame,
  })

  return {
    async render(t, o) {
      const s = state(t)
      device.queue.writeBuffer(
        sceneU,
        0,
        new Float32Array([t, t / duration, s.kick, 1, 0, 0, 0, 0]),
      )
      draw(scenePipe, sceneGroup, scene)
      const burst = s.wipe < 1 ? 0.22 * (1 - s.wipe) : 0
      if (s.wipe >= 1) {
        const hit = segments.length === 1 && s.look.id !== 'source' && s.kick > 0.6 ? 0.12 : 0
        return [{ color: looks.apply(scene, lookParams(s.look, o.frame, hit)), alpha: 'opaque' }]
      }
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToTexture(
        { texture: looks.apply(scene, lookParams(s.before, o.frame, burst)) },
        { texture: held },
        [width, height],
      )
      device.queue.submit([encoder.finish()])
      const to = looks.apply(scene, lookParams(s.look, o.frame, burst))
      wipeGroup ??= device.createBindGroup({
        layout: wipePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: wipeU } },
          { binding: 1, resource: held.createView() },
          { binding: 2, resource: to.createView() },
        ],
      })
      device.queue.writeBuffer(wipeU, 0, new Float32Array([s.wipe, s.direction, 2, 0]))
      draw(wipePipe, wipeGroup, wiped)
      return [{ color: wiped, alpha: 'opaque' }]
    },
    status(t) {
      const s = state(t)
      if (segments.length === 1) return s.look.id === 'source' ? 'pass off' : s.look.label
      return `${String(s.segment + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${s.look.label}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'looks', look: s.look.id, from: s.before.id, wipe: s.wipe, kick: s.kick }
    },
  }
}

export default lookScreenPasses
