// The set the two camera previews film: a procedural city of instanced columns on a grid floor,
// drawn with raw WebGPU through a view-projection matrix (camera-keyframes' viewProjection), in the
// look of a wireframe render: near-black faces, white edges, fog into black, a few red towers and a
// red monolith at the origin as the subject. The columns rise and fall in waves that repeat every
// loop, so the city at t = 6 is the city at t = 0.

const CITY_WGSL = /* wgsl */ `
struct U { vp: mat4x4f, a: vec4f, b: vec4f }  // a: loop phase, kick, fog density, grid; b: eye xyz
@group(0) @binding(0) var<uniform> u: U;

const TAU = 6.2831853;
const N = 44.0;      // cells a side
const CELL = 1.0;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) size: vec2f,   // the face's size in world units, along uv
  @location(2) world: vec3f,
  @location(3) normal: vec3f,
  @location(4) @interpolate(flat) kind: f32,  // 0 column, 1 red column, 2 monolith, 3 floor
}

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

// The face axes of a unit cube: normal, u, w with cross(u, w) = normal.
fn faceN(f: u32) -> vec3f {
  switch f { case 0u: { return vec3f(1, 0, 0); } case 1u: { return vec3f(-1, 0, 0); }
    case 2u: { return vec3f(0, 1, 0); } case 3u: { return vec3f(0, -1, 0); }
    case 4u: { return vec3f(0, 0, 1); } default: { return vec3f(0, 0, -1); } }
}
fn faceU(f: u32) -> vec3f {
  switch f { case 0u: { return vec3f(0, 0, -1); } case 1u: { return vec3f(0, 0, 1); }
    case 5u: { return vec3f(-1, 0, 0); } default: { return vec3f(1, 0, 0); } }
}
fn faceW(f: u32) -> vec3f {
  switch f { case 2u: { return vec3f(0, 0, -1); } case 3u: { return vec3f(0, 0, 1); }
    default: { return vec3f(0, 1, 0); } }
}

// Every column's footprint and height at the loop phase: towers by chance, and two waves that
// cross the city a whole number of times a loop.
fn column(i: u32) -> vec4f {
  let gx = f32(i % u32(N)) - N * 0.5 + 0.5;
  let gz = f32(i / u32(N)) - N * 0.5 + 0.5;
  let c = vec2f(gx, gz) * CELL;
  let r = hash(c);
  let r2 = hash(c + 17.3);
  let ph = u.a.x;
  let w1 = max(0.0, sin(c.x * 0.32 + c.y * 0.18 - ph * TAU * 2.0));
  let w2 = max(0.0, sin(length(c - vec2f(-9.0, 6.0)) * 0.45 - ph * TAU * 3.0));
  var h = 0.15 + 3.2 * pow(r, 6.0) + 0.9 * pow(w1, 3.0) + 0.6 * pow(w2, 4.0) * r2;
  let plaza = max(abs(c.x), abs(c.y)) < 4.1;
  if (plaza) { h = 0.04; }
  let red = select(0.0, 1.0, r2 > 0.985 && !plaza);
  return vec4f(c, h * (1.0 + 0.25 * u.a.y * r2), red);
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let f = vi / 6u;
  let k = vi % 6u;
  var q = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1));
  let uv = q[k];
  let n = faceN(f);
  let fu = faceU(f);
  let fw = faceW(f);
  let local = n * 0.5 + (uv.x - 0.5) * fu + (uv.y - 0.5) * fw + vec3f(0, 0.5, 0);
  var centre = vec2f(0.0);
  var scale = vec3f(1.0);
  var kind = 0.0;
  let count = u32(N * N);
  if (ii < count) {
    let c = column(ii);
    centre = c.xy;
    let s = 0.74 + 0.12 * hash(c.xy + 3.1);
    scale = vec3f(s, c.z, s);
    kind = c.w;
  } else if (ii == count) {
    // The monolith: the subject every shot frames.
    scale = vec3f(0.9, 4.0, 0.36);
    kind = 2.0;
  } else {
    // The floor, a slab under everything.
    scale = vec3f(N * CELL * 3.0, 0.02, N * CELL * 3.0);
    centre = vec2f(0.0);
    kind = 3.0;
  }
  let world = vec3f(centre.x, 0.0, centre.y) + local * scale - select(vec3f(0.0), vec3f(0, 0.02, 0), kind == 3.0);
  var o: V;
  o.pos = u.vp * vec4f(world, 1.0);
  o.uv = uv;
  o.size = vec2f(dot(abs(fu), scale), dot(abs(fw), scale));
  o.world = world;
  o.normal = n;
  o.kind = kind;
  return o;
}

@fragment fn fs(i: V) -> @location(0) vec4f {
  let eye = u.b.xyz;
  let dist = length(i.world - eye);
  let fog = exp(-pow(dist * u.a.z, 2.0));
  // Every derivative first, in uniform control flow.
  let g = i.world.xz / u.a.w;
  let d = abs(fract(g + 0.5) - 0.5) / fwidth(g);
  let g4 = g * 0.25;
  let d4 = abs(fract(g4 + 0.5) - 0.5) / fwidth(g4);
  let e = min(min(i.uv.x * i.size.x, (1.0 - i.uv.x) * i.size.x), min(i.uv.y * i.size.y, (1.0 - i.uv.y) * i.size.y));
  let px = fwidth(e);
  var col = vec3f(0.0);
  if (i.kind == 3.0) {
    // The floor: a fine grid, every fourth line brighter.
    let line = 1.0 - min(min(d.x, d.y), 1.0);
    let line4 = 1.0 - min(min(d4.x, d4.y), 1.0);
    col = vec3f(0.16) * line + vec3f(0.3) * line4;
  } else {
    // Faces nearly black, lit a little by a key from above-left; edges white, brighter on the
    // few towers picked out.
    let key = normalize(vec3f(-0.5, 0.9, 0.35));
    let lit = 0.03 + 0.09 * max(dot(i.normal, key), 0.0);
    let edge = 1.0 - smoothstep(0.6 * px, 1.8 * px, e);
    var ink = vec3f(0.8);
    var face = vec3f(lit);
    if (i.kind == 1.0) { ink = vec3f(1.6); face = vec3f(lit * 2.5); }
    if (i.kind == 2.0) {
      // The monolith: pale and luminous, with a pastel sheen (peach to lilac) that shifts with the
      // view, and scan lines that climb it four times a loop.
      let view = normalize(eye - i.world);
      let f = 1.0 - max(dot(i.normal, view), 0.0);
      let hue = i.world.y * 0.35 + f * 1.4 + u.a.x * 2.0;
      let peach = vec3f(1.0, 0.74, 0.6);
      let lilac = vec3f(0.74, 0.66, 1.0);
      let sheen = mix(peach, lilac, 0.5 + 0.5 * sin(TAU * hue));
      ink = vec3f(1.2);
      face = mix(vec3f(0.9), sheen, 0.7) * (0.6 + 0.45 * max(dot(i.normal, key), 0.0));
      let scan = pow(0.5 + 0.5 * sin(i.world.y * 6.0 - u.a.x * TAU * 4.0), 24.0);
      face += vec3f(1.0) * scan * 0.9;
    }
    // A height band of light on the columns, rising with the waves.
    let band = smoothstep(0.43, 0.49, abs(fract(i.world.y * 0.5 - u.a.x * 2.0) - 0.5));
    face += vec3f(0.55) * band * select(1.0, 0.0, i.kind == 2.0) * step(0.5, abs(i.normal.y - 1.0));
    col = mix(face, ink, edge);
  }
  return vec4f(col * fog, 1.0);
}
`

export type City = {
  /** Draws the city through `vp` (projection × view, column-major) and returns the frame. */
  render(
    vp: Float32Array,
    eye: readonly [number, number, number],
    o: { phase: number; kick?: number; fog?: number },
  ): GPUTexture
}

export const createCity = (device: GPUDevice, width: number, height: number): City => {
  const format: GPUTextureFormat = 'rgba8unorm'
  const module = device.createShaderModule({ code: CITY_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  })
  const color = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
  const depth = device.createTexture({
    size: [width, height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const uniforms = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniforms } }],
  })
  const instances = 44 * 44 + 2
  return {
    render(vp, eye, o) {
      const u = new Float32Array(24)
      u.set(vp, 0)
      u.set([o.phase, o.kick ?? 0, o.fog ?? 0.05, 1], 16)
      u.set([eye[0], eye[1], eye[2], 0], 20)
      device.queue.writeBuffer(uniforms, 0, u)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(36, instances)
      pass.end()
      device.queue.submit([encoder.finish()])
      return color
    },
  }
}

/** A world point through `vp` to pixels (y down), or null behind the camera. */
export const project = (
  vp: ArrayLike<number>,
  p: readonly [number, number, number],
  width: number,
  height: number,
) => {
  const m = (i: number) => vp[i] ?? 0
  const x = m(0) * p[0] + m(4) * p[1] + m(8) * p[2] + m(12)
  const y = m(1) * p[0] + m(5) * p[1] + m(9) * p[2] + m(13)
  const w = m(3) * p[0] + m(7) * p[1] + m(11) * p[2] + m(15)
  if (w < 0.05) return null
  return { x: (x / w + 1) * 0.5 * width, y: (1 - y / w) * 0.5 * height, w }
}
