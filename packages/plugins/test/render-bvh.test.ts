// render-bvh, headless on Dawn: a random triangle soup and a sphere with shared vertices, each built
// into a tree and queried by random rays in a compute shader that includes BVH_WGSL. Checked: the
// tree holds every triangle once inside its nodes' boxes; the same mesh gives the same bytes; the
// closest hit on the GPU is the brute-force one on the CPU (the triangle, t and barycentrics), and
// so is any-hit under a tMax either side of it. Rays that graze an edge or tie two triangles within
// float precision are left out, since f32 and f64 may fairly disagree there.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BVH_DEPTH, type Bvh, buildBvh } from '../render-bvh/src/render/bvh.ts'
import { BVH_WGSL } from '../render-bvh/src/render/bvh.wgsl.ts'
import { openFrame } from './frame.ts'

const MISS = 0xffffffff

/** A seeded 0–1 generator (mulberry32). */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Triangles of every size, scattered and overlapping in a cube, none sharing a vertex. */
const soup = (count: number, seed: number) => {
  const r = random(seed)
  const positions = new Float32Array(count * 9)
  for (let t = 0; t < count; t++) {
    const size = 0.02 + 0.6 * r() ** 3
    const c = [r() * 4 - 2, r() * 4 - 2, r() * 4 - 2]
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = (c[k % 3] ?? 0) + (r() - 0.5) * size
  }
  return { positions, indices: new Uint32Array(count * 3).map((_, i) => i) }
}

/** A UV sphere of radius 1.5 with shared vertices and 16-bit indices. */
const sphere = (rows: number, cols: number) => {
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= rows; i++)
    for (let j = 0; j <= cols; j++) {
      const th = (i / rows) * Math.PI
      const ph = (j / cols) * Math.PI * 2
      positions.push(
        1.5 * Math.sin(th) * Math.cos(ph),
        1.5 * Math.cos(th),
        1.5 * Math.sin(th) * Math.sin(ph),
      )
    }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j
      const b = a + cols + 1
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) }
}

type Mesh = { positions: Float32Array; indices: Uint32Array | Uint16Array }
type Ray = { o: number[]; d: number[]; tMin: number; tMax: number }

/** Möller–Trumbore in f64 with no rejection: t, u, v of the ray's line through the plane. */
const plane = (m: Mesh, t: number, o: number[], d: number[]) => {
  const v = (c: number) => {
    const i = m.indices[t * 3 + c] ?? 0
    return [0, 1, 2].map((k) => m.positions[i * 3 + k] ?? 0)
  }
  const [v0, v1, v2] = [v(0), v(1), v(2)] as [number[], number[], number[]]
  const e1 = v1.map((x, k) => x - (v0[k] ?? 0))
  const e2 = v2.map((x, k) => x - (v0[k] ?? 0))
  const cross = (a: number[], b: number[]) => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ]
  const dot = (a: number[], b: number[]) => a.reduce((s, x, k) => s + x * (b[k] ?? 0), 0)
  const p = cross(d, e2)
  const det = dot(e1, p)
  if (Math.abs(det) < 1e-12) return undefined
  const s = o.map((x, k) => x - (v0[k] ?? 0))
  const q = cross(s, e1)
  return { t: dot(e2, q) / det, u: dot(s, p) / det, v: dot(d, q) / det }
}

const EDGE = 1e-4
const NEAR = 1e-4

/** The closest hit by testing every triangle, and whether f32 could fairly see it otherwise. */
const bruteForce = (m: Mesh, ray: Ray) => {
  const n = m.indices.length / 3
  const hits: { t: number; u: number; v: number; tri: number; margin: number }[] = []
  for (let tri = 0; tri < n; tri++) {
    const h = plane(m, tri, ray.o, ray.d)
    if (h) hits.push({ ...h, tri, margin: Math.min(h.u, h.v, 1 - h.u - h.v) })
  }
  const inside = hits.filter((h) => h.margin >= 0 && h.t > ray.tMin && h.t < ray.tMax)
  inside.sort((a, b) => a.t - b.t || a.tri - b.tri)
  const best = inside[0]
  const reach = (best?.t ?? ray.tMax) * (1 + NEAR) + NEAR
  const unsure = hits.some(
    (h) =>
      h.t < reach &&
      h.t > ray.tMin - NEAR &&
      (Math.abs(h.margin) < EDGE ||
        Math.abs(h.t - ray.tMin) < NEAR ||
        (h !== best && h.margin >= 0 && best && Math.abs(h.t - best.t) < NEAR * (1 + best.t))),
  )
  return { best, unsure }
}

/** Rays from a box around the mesh towards points inside it. */
const raysOf = (count: number, seed: number) => {
  const r = random(seed)
  return Array.from({ length: count }, (): Ray => {
    const o = [r() * 8 - 4, r() * 8 - 4, r() * 8 - 4]
    const aim = [r() * 4 - 2, r() * 4 - 2, r() * 4 - 2]
    const d = aim.map((x, k) => x - (o[k] ?? 0))
    const l = r() < 0.5 ? 1 : Math.hypot(...d)
    return { o, d: d.map((x) => x / l), tMin: 1e-3, tMax: 1e30 }
  })
}

/** Runs closest-hit with (tMin, 1e30) and any-hit with (tMin, `shadow`) for each ray on the GPU. */
const query = async (bvh: Bvh, rays: Ray[], shadow: number[]) => {
  const { device, done } = await openFrame(1, 1)
  const storage = (data: ArrayBufferView<ArrayBuffer>, usage = 0) => {
    const b = device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | usage,
    })
    device.queue.writeBuffer(b, 0, data)
    return b
  }
  const n = rays.length
  const packed = new Float32Array(n * 8)
  rays.forEach((r, i) => {
    packed.set([...r.o, r.tMin, ...r.d, shadow[i] ?? 0], i * 8)
  })
  const nodes = storage(bvh.nodes)
  const triangles = storage(bvh.triangles)
  const input = storage(packed)
  const out = storage(new Uint32Array(n * 5), GPUBufferUsage.COPY_SRC)
  const module = device.createShaderModule({
    code: /* wgsl */ `${BVH_WGSL}
@group(0) @binding(0) var<storage, read> bvhNodes: array<vec4f>;
@group(0) @binding(1) var<storage, read> bvhTriangles: array<vec4f>;
@group(0) @binding(2) var<storage, read> rays: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> hits: array<u32>;

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&rays) / 2u) { return; }
  let o = rays[i * 2u];
  let d = rays[i * 2u + 1u];
  let h = bvhClosest(o.xyz, d.xyz, o.w, 1e30);
  hits[i * 5u] = bitcast<u32>(h.t);
  hits[i * 5u + 1u] = h.triangle;
  hits[i * 5u + 2u] = bitcast<u32>(h.u);
  hits[i * 5u + 3u] = bitcast<u32>(h.v);
  hits[i * 5u + 4u] = select(0u, 1u, bvhAny(o.xyz, d.xyz, o.w, d.w));
}
`,
  })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [nodes, triangles, input, out].map((buffer, binding) => ({
      binding,
      resource: { buffer },
    })),
  })
  const read = device.createBuffer({
    size: n * 20,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const e = device.createCommandEncoder()
  const pass = e.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bind)
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  e.copyBufferToBuffer(out, 0, read, 0, n * 20)
  device.queue.submit([e.finish()])
  await read.mapAsync(GPUMapMode.READ)
  const words = new Uint32Array(read.getMappedRange().slice(0))
  read.unmap()
  done()
  const floats = new Float32Array(words.buffer)
  return Array.from({ length: n }, (_, i) => ({
    t: floats[i * 5] ?? 0,
    tri: words[i * 5 + 1] ?? 0,
    u: floats[i * 5 + 2] ?? 0,
    v: floats[i * 5 + 3] ?? 0,
    any: words[i * 5 + 4] === 1,
  }))
}

/** Every triangle once, in boxes that hold it, each inner node's box holding its children's. */
const checkTree = (m: Mesh, bvh: Bvh) => {
  const n = m.indices.length / 3
  const bits = new Uint32Array(bvh.nodes.buffer)
  const ids = new Uint32Array(bvh.triangles.buffer)
  const seen = new Uint8Array(n)
  const within = (node: number, p: ArrayLike<number>) =>
    [0, 1, 2].every(
      (k) =>
        (p[k] ?? 0) >= (bvh.nodes[node * 8 + k] ?? 0) &&
        (p[k] ?? 0) <= (bvh.nodes[node * 8 + 4 + k] ?? 0),
    )
  const visit = (node: number, level: number) => {
    assert.ok(level < BVH_DEPTH)
    const first = bits[node * 8 + 3] ?? 0
    const count = bits[node * 8 + 7] ?? 0
    if (count === 0) {
      for (const c of [first, first + 1]) {
        assert.ok(within(node, bvh.nodes.subarray(c * 8, c * 8 + 3)))
        assert.ok(within(node, bvh.nodes.subarray(c * 8 + 4, c * 8 + 7)))
        visit(c, level + 1)
      }
      return
    }
    for (let i = first; i < first + count; i++) {
      seen[ids[i * 12 + 3] ?? 0]++
      for (let c = 0; c < 3; c++)
        assert.ok(within(node, bvh.triangles.subarray(i * 12 + c * 4, i * 12 + c * 4 + 3)))
    }
  }
  visit(0, 0)
  assert.ok(
    seen.every((s) => s === 1),
    'every triangle in one leaf',
  )
}

const compare = async (m: Mesh, bvh: Bvh, rays: Ray[], seed: number) => {
  const r = random(seed)
  const truth = rays.map((ray) => bruteForce(m, ray))
  // tMax for any-hit: past the closest hit or short of it, or far away.
  const shadow = truth.map(({ best }) => (best ? best.t * (r() < 0.5 ? 0.6 : 1.4) : 1e30))
  const gpu = await query(bvh, rays, shadow)
  let checked = 0
  let hits = 0
  let blocked = 0
  gpu.forEach((g, i) => {
    const { best, unsure } = truth[i] ?? { best: undefined, unsure: true }
    if (unsure) return
    checked++
    if (!best) {
      assert.equal(g.tri, MISS, `ray ${i}: a miss`)
      assert.equal(g.any, false, `ray ${i}: nothing in the way`)
      return
    }
    hits++
    assert.equal(g.tri, best.tri, `ray ${i}: triangle ${best.tri} at ${best.t}, got ${g.t}`)
    assert.ok(Math.abs(g.t - best.t) < 1e-4 * (1 + best.t), `ray ${i}: t ${g.t} vs ${best.t}`)
    assert.ok(Math.abs(g.u - best.u) < 1e-3 && Math.abs(g.v - best.v) < 1e-3, `ray ${i}: u, v`)
    const behind = (shadow[i] ?? 0) > best.t
    if (behind) blocked++
    assert.equal(g.any, behind, `ray ${i}: any-hit under tMax ${shadow[i]}, closest ${best.t}`)
  })
  assert.ok(checked > rays.length * 0.95, `${checked} of ${rays.length} rays checked`)
  return { hits, blocked, checked }
}

test('render-bvh: a random soup and a 16-bit sphere, every triangle once, in its boxes', () => {
  const s = soup(3000, 7)
  const bvh = buildBvh(s.positions, s.indices)
  checkTree(s, bvh)
  assert.equal(bvh.triangleCount, 3000)
  assert.equal(bvh.nodes.length, bvh.nodeCount * 8)
  assert.ok(bvh.nodeCount < 2 * 3000)
  const again = buildBvh(s.positions, s.indices)
  assert.deepEqual(again.nodes, bvh.nodes, 'the same mesh gives the same nodes')
  assert.deepEqual(again.triangles, bvh.triangles, 'and the same triangles')
  const ball = sphere(24, 48)
  checkTree(ball, buildBvh(ball.positions, ball.indices, { bins: 16, leaf: 1 }))
  // Many triangles in one place: no plane parts them, and the tree still holds them all.
  const stack = new Float32Array(9 * 50).map((_, i) => [0, 0, 0, 1, 0, 0, 0, 1, 0][i % 9] ?? 0)
  const all = new Uint32Array(150).map((_, i) => i)
  checkTree({ positions: stack, indices: all }, buildBvh(stack, all))
  const none = buildBvh(new Float32Array(0), new Uint32Array(0))
  assert.deepEqual([none.nodeCount, none.triangleCount, none.triangles.length], [1, 0, 12])
  assert.throws(() => buildBvh(new Float32Array(9), new Uint32Array(4)), /whole number/)
  assert.throws(() => buildBvh(new Float32Array(9), new Uint32Array([0, 1, 3])), /vertex 3/)
})

test('render-bvh: GPU closest-hit and any-hit match brute force on random rays', async () => {
  const s = soup(1500, 11)
  const r = await compare(s, buildBvh(s.positions, s.indices), raysOf(3000, 3), 5)
  assert.ok(r.hits > 800 && r.blocked > 300, `${r.hits} hits, ${r.blocked} blocked`)
  const ball = sphere(20, 40)
  const b = await compare(ball, buildBvh(ball.positions, ball.indices), raysOf(2000, 9), 6)
  assert.ok(b.hits > 500 && b.checked - b.hits > 300, `${b.hits} hits of ${b.checked}`)
  // No triangles: every ray misses.
  const none: Mesh = { positions: new Float32Array(0), indices: new Uint32Array(0) }
  // Rays through the origin, where the empty root's box is: none loops on it.
  const origin: Ray[] = [
    { o: [-1, -2, -3], d: [1, 2, 3], tMin: 1e-3, tMax: 1e30 },
    { o: [0, 0, 5], d: [0, 0, -1], tMin: 1e-3, tMax: 1e30 },
  ]
  const empty = await compare(
    none,
    buildBvh(none.positions, none.indices),
    [...raysOf(64, 2), ...origin],
    1,
  )
  assert.equal(empty.hits, 0)
})
