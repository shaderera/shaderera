// render-bvh: a mesh made in code, a torus knot over a square floor, built into a tree every frame
// with buildBvh and ray traced in one compute pass that includes BVH_WGSL, the way the README
// shows: four closest-hit rays a pixel for the picture, and from each hit an any-hit ray to the
// light for the shadow. A swelling runs twice along the knot's tube a loop, so the mesh and its
// tree change on every frame, and the camera goes once round it. The shading is the preview's own,
// as a film's would be: grey diffuse, normals looked up by the hit's triangle and blended by its
// barycentrics, and the triangles' edges drawn from them. The plugin only finds the hits.

import { createHouse, type Word } from '../../previews/src/house.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import { buildBvh } from '../../previews/src/render/bvh.ts'
import { BVH_WGSL } from '../../previews/src/render/bvh.wgsl.ts'

const TAU = Math.PI * 2
/** The knot: rings along the tube, vertices around each ring, and its p, q windings. */
const ALONG = 480
const AROUND = 20
const P = 2
const Q = 3
/** The floor: FLOOR × FLOOR quads, 7 units square, under the knot. */
const FLOOR = 12
const KNOT_VERTICES = ALONG * AROUND
const VERTICES = KNOT_VERTICES + (FLOOR + 1) ** 2
const KNOT_TRIANGLES = KNOT_VERTICES * 2
const TRIANGLES = KNOT_TRIANGLES + FLOOR * FLOOR * 2

type V3 = [number, number, number]
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/** A point on the knot's centre line, lying flat, y up. */
const knotAt = (u: number): V3 => {
  const r = 1.15 + 0.48 * Math.cos(Q * u)
  return [r * Math.cos(P * u), 0.48 * Math.sin(Q * u), r * Math.sin(P * u)]
}

/** The triangles, the same every frame: the knot's quads, then the floor's. */
const meshIndices = () => {
  const indices = new Uint32Array(TRIANGLES * 3)
  let k = 0
  const quad = (a: number, b: number, c: number, d: number) => {
    indices.set([a, b, c, c, b, d], k)
    k += 6
  }
  for (let i = 0; i < ALONG; i++)
    for (let j = 0; j < AROUND; j++) {
      const next = (i + 1) % ALONG
      const turn = (j + 1) % AROUND
      quad(i * AROUND + j, next * AROUND + j, i * AROUND + turn, next * AROUND + turn)
    }
  for (let z = 0; z < FLOOR; z++)
    for (let x = 0; x < FLOOR; x++) {
      const a = KNOT_VERTICES + z * (FLOOR + 1) + x
      quad(a, a + FLOOR + 1, a + 1, a + FLOOR + 2)
    }
  return indices
}

/** Positions and vertex normals at loop phase `ph`: the tube swells where a wave passes. */
const meshAt = (ph: number, positions: Float32Array, normals: Float32Array) => {
  for (let i = 0; i < ALONG; i++) {
    const u = (i / ALONG) * TAU
    const c = knotAt(u)
    const ahead = knotAt(u + 0.01)
    const t = norm([ahead[0] - c[0], ahead[1] - c[1], ahead[2] - c[2]])
    const b = norm(cross(t, [c[0] + ahead[0], c[1] + ahead[1], c[2] + ahead[2]]))
    const n = cross(b, t)
    const radius = 0.15 + 0.17 * Math.max(0, Math.cos(u * 2 - ph * TAU * 2)) ** 6
    for (let j = 0; j < AROUND; j++) {
      const a = (j / AROUND) * TAU
      const d: V3 = [
        n[0] * Math.cos(a) + b[0] * Math.sin(a),
        n[1] * Math.cos(a) + b[1] * Math.sin(a),
        n[2] * Math.cos(a) + b[2] * Math.sin(a),
      ]
      const v = (i * AROUND + j) * 3
      positions.set([c[0] + d[0] * radius, c[1] + d[1] * radius, c[2] + d[2] * radius], v)
      normals.set(d, v)
    }
  }
  for (let z = 0; z <= FLOOR; z++)
    for (let x = 0; x <= FLOOR; x++) {
      const v = (KNOT_VERTICES + z * (FLOOR + 1) + x) * 3
      positions.set([(x / FLOOR - 0.5) * 7, -1.05, (z / FLOOR - 0.5) * 7], v)
      normals.set([0, 1, 0], v)
    }
}

const TRACE_WGSL = /* wgsl */ `${BVH_WGSL}
@group(0) @binding(0) var<storage, read> bvhNodes: array<vec4f>;
@group(0) @binding(1) var<storage, read> bvhTriangles: array<vec4f>;
@group(0) @binding(2) var<storage, read> meshIndices: array<u32>;
@group(0) @binding(3) var<storage, read> meshNormals: array<f32>;
@group(0) @binding(4) var<uniform> cam: Cam;
@group(0) @binding(5) var picture: texture_storage_2d<rgba8unorm, write>;

// The eye; right and up a pixel; forward; the direction to the light; the picture's centre in px.
struct Cam { eye: vec4f, right: vec4f, up: vec4f, forward: vec4f, light: vec4f, centre: vec4f }

const KNOT = ${KNOT_TRIANGLES}u;

fn normalOf(vertex: u32) -> vec3f {
  return vec3f(meshNormals[vertex * 3u], meshNormals[vertex * 3u + 1u], meshNormals[vertex * 3u + 2u]);
}

// One sample: premultiplied grey, alpha 0 where the ray meets nothing.
fn sample(o: vec3f, d: vec3f) -> vec4f {
  let hit = bvhClosest(o, d, 1e-4, 1e30);
  if (hit.triangle == BVH_MISS) { return vec4f(0.0); }
  // The film's own data, looked up by the triangle's index in the mesh.
  let k = hit.triangle * 3u;
  let w = vec3f(1.0 - hit.u - hit.v, hit.u, hit.v);
  var n = normalize(
    normalOf(meshIndices[k]) * w.x + normalOf(meshIndices[k + 1u]) * w.y +
      normalOf(meshIndices[k + 2u]) * w.z,
  );
  if (dot(n, d) > 0.0) { n = -n; }
  let p = o + d * hit.t;
  let l = cam.light.xyz;
  let lit = select(1.0, 0.0, bvhAny(p + n * 2e-3, l, 1e-4, 1e30));
  let knot = hit.triangle < KNOT;
  let albedo = select(0.3, 0.86, knot);
  var c = albedo * (0.07 + 0.08 * (n.y * 0.5 + 0.5) + 0.85 * max(dot(n, l), 0.0) * lit);
  // The triangles' edges, where a barycentric nears 0.
  let edge = min(min(w.x, w.y), w.z);
  c *= mix(select(0.55, 0.75, knot), 1.0, smoothstep(0.0, select(0.03, 0.06, knot), edge));
  // The floor fades out before its square edge.
  let a = select(1.0 - smoothstep(1.6, 3.4, length(p.xz)), 1.0, knot);
  return vec4f(vec3f(pow(c, 1.0 / 2.2)) * a, a);
}

@compute @workgroup_size(8, 8) fn trace(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(picture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  var sum = vec4f(0.0);
  for (var s = 0u; s < 4u; s++) {
    let px = vec2f(id.xy) + vec2f(f32(s & 1u), f32(s >> 1u)) * 0.5 + 0.25 - cam.centre.xy;
    let d = normalize(cam.forward.xyz + cam.right.xyz * px.x - cam.up.xyz * px.y);
    sum += sample(cam.eye.xyz, d);
  }
  textureStore(picture, id.xy, sum / 4.0);
}
`

const renderBvh: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-bvh has no state "${stateId}"`)
  const device = host.gpu
  if (!device) throw new Error('The render-bvh preview needs WebGPU (host.gpu)')
  const { width: W, height: H, duration } = host.manifest
  const indices = meshIndices()
  const positions = new Float32Array(VERTICES * 3)
  const normals = new Float32Array(VERTICES * 3)

  const buffer = (size: number, usage: number) =>
    device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST })
  const nodes = buffer((2 * TRIANGLES - 1) * 32, GPUBufferUsage.STORAGE)
  const triangles = buffer(TRIANGLES * 48, GPUBufferUsage.STORAGE)
  const indexBuffer = buffer(indices.byteLength, GPUBufferUsage.STORAGE)
  const normalBuffer = buffer(normals.byteLength, GPUBufferUsage.STORAGE)
  const camBuffer = buffer(96, GPUBufferUsage.UNIFORM)
  device.queue.writeBuffer(indexBuffer, 0, indices)
  const picture = device.createTexture({
    size: [W, H],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: TRACE_WGSL }), entryPoint: 'trace' },
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      ...[nodes, triangles, indexBuffer, normalBuffer, camBuffer].map((b, binding) => ({
        binding,
        resource: { buffer: b },
      })),
      { binding: 5, resource: picture.createView() },
    ],
  })

  const bg = host.io.canvas(W, H)
  const bgCtx = bg.getContext('2d') as OffscreenCanvasRenderingContext2D
  bgCtx.fillStyle = '#000'
  bgCtx.fillRect(0, 0, W, H)
  createHouse(host, bgCtx).index()
  const canvas = host.io.canvas(W, H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const top: Word[] = [{ from: 0, to: duration, text: 'CLOSEST HIT' }]
  const bottom: Word[] = [
    {
      from: 0,
      to: duration,
      text: `${TRIANGLES.toLocaleString('en-US').replace(',', ' ')} TRIANGLES`,
    },
  ]

  /** The camera: once round the knot a loop, a little above it, rising and falling once. */
  const camera = (t: number) => {
    const az = (t / duration) * TAU + 0.5
    const eye: V3 = [
      6.8 * Math.sin(az),
      3.2 + 0.5 * Math.sin((t / duration) * TAU),
      6.8 * Math.cos(az),
    ]
    const forward = norm([-eye[0], -0.3 - eye[1], -eye[2]])
    const right = norm(cross(forward, [0, 1, 0]))
    const up = cross(right, forward)
    return { eye, forward, right, up }
  }
  const light = norm([-0.55, 1, 0.3])
  /** Half the picture's height spans 19° either side of forward. */
  const pixel = Math.tan((19 * Math.PI) / 180) / (H / 2)

  /** The tree at t: the mesh at its phase, built again. */
  const treeAt = (t: number) => {
    meshAt(t / duration, positions, normals)
    return buildBvh(positions, indices)
  }

  return {
    async render(t, o) {
      const bvh = treeAt(t)
      device.queue.writeBuffer(nodes, 0, bvh.nodes)
      device.queue.writeBuffer(triangles, 0, bvh.triangles)
      device.queue.writeBuffer(normalBuffer, 0, normals)
      const c = camera(t)
      // The picture's centre sits in the middle of the area above the caption.
      // biome-ignore format: a vec4 a row
      device.queue.writeBuffer(camBuffer, 0, new Float32Array([
        ...c.eye, 0,
        ...c.right.map((x) => x * pixel), 0,
        ...c.up.map((x) => x * pixel), 0,
        ...c.forward, 0,
        ...light, 0,
        W / 2, 452, 0, 0,
      ]))
      const e = device.createCommandEncoder()
      const pass = e.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8))
      pass.end()
      device.queue.submit([e.finish()])

      ctx.clearRect(0, 0, W, H)
      house.wash(W)
      house.words(top, bottom, t, o.frame)
      house.note(
        'one ray to the surface, one to the light, through a tree built every frame',
        1032,
        800,
      )
      house.hud(
        t,
        o.frame,
        `${bvh.nodeCount.toLocaleString('en-US')} NODES   DEPTH ${bvh.depth}`,
        'BINNED SAH   ANY-HIT SHADOWS',
      )
      return [
        { color: bg, name: 'black' },
        { color: picture, alpha: 'premultiplied', name: 'traced' },
        { color: canvas, name: 'header' },
      ]
    },
    status(t) {
      return `${treeAt(t).nodeCount} nodes`
    },
    inspect(t) {
      const bvh = treeAt(t)
      return { id: 'bvh', triangles: TRIANGLES, nodes: bvh.nodeCount, depth: bvh.depth }
    },
  }
}

export default renderBvh
