// 3D Gaussian splats on the host's GPU, deterministic: `.splat` and binary 3DGS `.ply` loaded
// from bytes, EWA splatting (each splat's 3D covariance projected to a 2D ellipse), instanced quads
// blended back to front into a frame-size texture the host composites as a layer. The splats
// render as they are in the file: no grading, no effects.
// - The depth sort runs on the CPU every render: Float32 view depths, a stable LSD radix sort over
//   splat indices in index order, so equal depths keep index order and the same camera always gives
//   the same order (and the same pixels).
// - Only the DC term of the spherical harmonics is read (degree 0): colours do not change with the
//   view angle.

import type { Mat4 } from '@shaderera/core'

/** Splats as plain typed arrays, one entry (or 3, or 4) per splat. */
export type Splats = {
  count: number
  /** x, y, z in world units. */
  positions: Float32Array
  /** The Gaussian's standard deviation along its own x, y, z, in world units (linear, not log). */
  scales: Float32Array
  /** Unit quaternion w, x, y, z (the 3DGS order: rot_0 is w). */
  rotations: Float32Array
  /** r, g, b as display values (0–1, may exceed 1 from a .ply) and a = opacity 0–1, straight. */
  colors: Float32Array
}

const emptySplats = (count: number): Splats => ({
  count,
  positions: new Float32Array(count * 3),
  scales: new Float32Array(count * 3),
  rotations: new Float32Array(count * 4),
  colors: new Float32Array(count * 4),
})

const normalise = (r: Float32Array, i: number) => {
  const w = r[i * 4] ?? 0
  const x = r[i * 4 + 1] ?? 0
  const y = r[i * 4 + 2] ?? 0
  const z = r[i * 4 + 3] ?? 0
  const n = Math.hypot(w, x, y, z)
  if (n === 0) r.set([1, 0, 0, 0], i * 4)
  else r.set([w / n, x / n, y / n, z / n], i * 4)
}

/**
 * The common `.splat` format (antimatter15): 32 bytes a splat, little-endian. Position f32×3,
 * scale f32×3 (linear), colour u8×4 RGBA (A is opacity), rotation u8×4 quaternion w, x, y, z
 * stored as q × 128 + 128.
 */
export const parseSplat = (bytes: Uint8Array): Splats => {
  if (bytes.length % 32 !== 0)
    throw new Error(`A .splat file is 32 bytes a splat; this one has ${bytes.length} bytes.`)
  const n = bytes.length / 32
  const s = emptySplats(n)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < n; i++) {
    const o = i * 32
    for (let k = 0; k < 3; k++) {
      s.positions[i * 3 + k] = v.getFloat32(o + k * 4, true)
      s.scales[i * 3 + k] = v.getFloat32(o + 12 + k * 4, true)
    }
    for (let k = 0; k < 4; k++) {
      s.colors[i * 4 + k] = (bytes[o + 24 + k] ?? 0) / 255
      s.rotations[i * 4 + k] = ((bytes[o + 28 + k] ?? 128) - 128) / 128
    }
    normalise(s.rotations, i)
  }
  return s
}

const PLY_SIZES: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
}

const plyReader = (v: DataView, type: string): ((o: number) => number) => {
  switch (type) {
    case 'char':
    case 'int8':
      return (o) => v.getInt8(o)
    case 'uchar':
    case 'uint8':
      return (o) => v.getUint8(o)
    case 'short':
    case 'int16':
      return (o) => v.getInt16(o, true)
    case 'ushort':
    case 'uint16':
      return (o) => v.getUint16(o, true)
    case 'int':
    case 'int32':
      return (o) => v.getInt32(o, true)
    case 'uint':
    case 'uint32':
      return (o) => v.getUint32(o, true)
    case 'double':
    case 'float64':
      return (o) => v.getFloat64(o, true)
    default:
      return (o) => v.getFloat32(o, true)
  }
}

const SH_C0 = 0.28209479177387814

/**
 * A binary little-endian 3DGS `.ply` (the training output): x, y, z; f_dc_0..2 to colour as
 * 0.5 + SH_C0 × f_dc; opacity through a sigmoid; scale_0..2 through exp; rot_0..3 (w, x, y, z)
 * normalised. Higher spherical harmonics (f_rest_*) are skipped. Elements other than `vertex`
 * must come after it.
 */
export const parsePly = (bytes: Uint8Array): Splats => {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)))
  const end = head.indexOf('end_header')
  if (!head.startsWith('ply') || end < 0) throw new Error('Not a .ply file (no ply header).')
  const lines = head.slice(0, end).split(/\r?\n/)
  const bodyStart = head.slice(0, end).length + head.slice(end).indexOf('\n') + 1
  if (!lines.some((l) => l.trim() === 'format binary_little_endian 1.0'))
    throw new Error('Only binary_little_endian 1.0 .ply files are read.')
  let count = -1
  let inVertex = false
  let stride = 0
  const props = new Map<string, { offset: number; type: string }>()
  for (const line of lines) {
    const w = line.trim().split(/\s+/)
    if (w[0] === 'element') {
      if (count >= 0 && !inVertex) break
      inVertex = w[1] === 'vertex'
      if (inVertex) count = Number(w[2])
      else if (count < 0) throw new Error('The vertex element must come first in the .ply.')
    } else if (w[0] === 'property' && inVertex) {
      if (w[1] === 'list') throw new Error('List properties in a .ply vertex are not supported.')
      const type = w[1] ?? ''
      const size = PLY_SIZES[type]
      if (!size) throw new Error(`Unknown .ply property type ${type}.`)
      props.set(w[2] ?? '', { offset: stride, type })
      stride += size
    }
  }
  if (count < 0) throw new Error('The .ply has no vertex element.')
  if (bodyStart + count * stride > bytes.length)
    throw new Error(`The .ply says ${count} splats but has too few bytes for them.`)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const field = (name: string, fallback?: number) => {
    const p = props.get(name)
    if (p) {
      const read = plyReader(v, p.type)
      return (i: number) => read(bodyStart + i * stride + p.offset)
    }
    if (fallback === undefined) throw new Error(`The .ply has no ${name} property.`)
    return () => fallback
  }
  const pos = ['x', 'y', 'z'].map((n) => field(n))
  const dc = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map((n) => field(n))
  const opacity = field('opacity')
  const scale = ['scale_0', 'scale_1', 'scale_2'].map((n) => field(n))
  const rot = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map((n, k) => field(n, k === 0 ? 1 : 0))
  const s = emptySplats(count)
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      s.positions[i * 3 + k] = pos[k]?.(i) ?? 0
      s.colors[i * 4 + k] = Math.max(0, 0.5 + SH_C0 * (dc[k]?.(i) ?? 0))
      s.scales[i * 3 + k] = Math.exp(scale[k]?.(i) ?? 0)
    }
    s.colors[i * 4 + 3] = 1 / (1 + Math.exp(-opacity(i)))
    for (let k = 0; k < 4; k++) s.rotations[i * 4 + k] = rot[k]?.(i) ?? 0
    normalise(s.rotations, i)
  }
  return s
}

/** `.ply` by its header, `.splat` otherwise. */
export const parseSplats = (bytes: Uint8Array): Splats =>
  bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79 ? parsePly(bytes) : parseSplat(bytes)

/** Reads and parses a splat file of the project: `await loadSplats(host, 'assets/garden.ply')`. */
export const loadSplats = async (
  host: { io: { read(path: string): Promise<Uint8Array> } },
  path: string,
): Promise<Splats> => parseSplats(await host.io.read(path))

// One splat on the GPU, 16 f32: position, pad, colour (straight), the 3D covariance's upper
// triangle (xx, xy, xz, yy, yz, zz), pad ×2.
const FLOATS = 16

const SPLATS_WGSL = /* wgsl */ `
struct Splat { pos: vec4f, color: vec4f, c0: vec4f, c1: vec4f }
struct Uniforms { view: mat4x4f, proj: mat4x4f, viewport: vec4f }

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> splats: array<Splat>;
@group(0) @binding(2) var<storage, read> order: array<u32>;

struct Out {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  // Offset from the centre in standard deviations along the ellipse's axes.
  @location(1) uv: vec2f,
}

const CORNERS = array<vec2f, 4>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(1, 1));
const SIGMAS = 3.0;

@vertex fn splatVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  out.position = vec4f(0, 0, 2, 1); // culled
  out.color = vec4f(0);
  out.uv = vec2f(0);
  let s = splats[order[ii]];
  let t = u.view * vec4f(s.pos.xyz, 1);
  let clip = u.proj * t;
  if (clip.w <= 0.0 || clip.z < 0.0 || clip.z > clip.w) { return out; }
  let ndc = clip.xy / clip.w;
  if (any(abs(ndc) > vec2f(1.3))) { return out; }

  // The Jacobian of pixel coordinates (y up) at t, for any projection matrix; for a perspective
  // one the point is first clamped to 1.3× the frustum (as 3DGS does), so edge splats do not blow up.
  var tc = t;
  if (u.proj[2].w != 0.0) {
    let lim = vec2f(1.3) * clip.w / vec2f(abs(u.proj[0].x), abs(u.proj[1].y));
    tc = vec4f(clamp(t.xy, -lim, lim), t.z, 1);
  }
  let c = u.proj * tc;
  let half = 0.5 * u.viewport.xy;
  let jx = half.x * (vec3f(u.proj[0].x, u.proj[1].x, u.proj[2].x) * c.w
                    - vec3f(u.proj[0].w, u.proj[1].w, u.proj[2].w) * c.x) / (c.w * c.w);
  let jy = half.y * (vec3f(u.proj[0].y, u.proj[1].y, u.proj[2].y) * c.w
                    - vec3f(u.proj[0].w, u.proj[1].w, u.proj[2].w) * c.y) / (c.w * c.w);
  let w = mat3x3f(u.view[0].xyz, u.view[1].xyz, u.view[2].xyz);
  let sigma = mat3x3f(
    vec3f(s.c0.x, s.c0.y, s.c0.z),
    vec3f(s.c0.y, s.c0.w, s.c1.x),
    vec3f(s.c0.z, s.c1.x, s.c1.y),
  );
  // T = J W, rows jx and jy; the 2D covariance is T Σ Tᵀ, plus the 0.3 px² low-pass filter.
  let tx = jx * w; // row vector × matrix: (Wᵀ jx)ᵀ
  let ty = jy * w;
  let a = dot(tx, sigma * tx) + 0.3;
  let b = dot(tx, sigma * ty);
  let d = dot(ty, sigma * ty) + 0.3;

  let mid = 0.5 * (a + d);
  let rad = sqrt(max(0.25 * (a - d) * (a - d) + b * b, 0.0));
  let l1 = mid + rad;
  let l2 = max(mid - rad, 0.1);
  var e1 = vec2f(1, 0);
  if (abs(b) > 1e-12) { e1 = normalize(vec2f(b, l1 - a)); } else if (d > a) { e1 = vec2f(0, 1); }
  let e2 = vec2f(-e1.y, e1.x);
  let corner = CORNERS[vi] * SIGMAS;
  let px = corner.x * sqrt(l1) * e1 + corner.y * sqrt(l2) * e2;
  out.position = vec4f((ndc + px / half) * clip.w, clip.z, clip.w);
  out.color = s.color;
  out.uv = corner;
  return out;
}

@fragment fn splatFs(in: Out) -> @location(0) vec4f {
  let d = dot(in.uv, in.uv);
  if (d > SIGMAS * SIGMAS) { discard; }
  let alpha = min(0.99, in.color.a * exp(-0.5 * d));
  if (alpha < 1.0 / 255.0) { discard; }
  return vec4f(in.color.rgb * alpha, alpha);
}
`

export type SplatRendererOptions = {
  width: number
  height: number
  /**
   * 'rgba16float' (default) keeps precision while thousands of splats blend into one pixel;
   * 'rgba8unorm' halves the memory and bands in soft, deep overlaps.
   */
  format?: 'rgba16float' | 'rgba8unorm'
}

export type SplatRenderer = {
  /** Replaces the splats on the GPU. */
  upload(splats: Splats): void
  /**
   * Sorts, draws, and returns the frame-size texture: premultiplied alpha, transparent where there
   * are no splats. The same texture every call: composite or read it before the next render.
   */
  render(view: Mat4 | ArrayLike<number>, projection: Mat4 | ArrayLike<number>): GPUTexture
  /** The splats in back-to-front order from the last render (in front of the camera only). */
  readonly order: Uint32Array
  destroy(): void
}

/** The 3D covariance R S Sᵀ Rᵀ of every splat, upper triangle, into the GPU layout. */
const pack = (s: Splats): Float32Array<ArrayBuffer> => {
  const out = new Float32Array(Math.max(1, s.count) * FLOATS)
  for (let i = 0; i < s.count; i++) {
    const o = i * FLOATS
    out[o] = s.positions[i * 3] ?? 0
    out[o + 1] = s.positions[i * 3 + 1] ?? 0
    out[o + 2] = s.positions[i * 3 + 2] ?? 0
    for (let k = 0; k < 4; k++) out[o + 4 + k] = s.colors[i * 4 + k] ?? 0
    const w = s.rotations[i * 4] ?? 1
    const x = s.rotations[i * 4 + 1] ?? 0
    const y = s.rotations[i * 4 + 2] ?? 0
    const z = s.rotations[i * 4 + 3] ?? 0
    // biome-ignore format: a rotation matrix reads as rows
    const r = [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ]
    const sc = [s.scales[i * 3] ?? 0, s.scales[i * 3 + 1] ?? 0, s.scales[i * 3 + 2] ?? 0]
    // M = R S; Σ = M Mᵀ
    const m = r.map((v, j) => v * (sc[j % 3] ?? 0))
    const cov = (a: number, b: number) =>
      (m[a * 3] ?? 0) * (m[b * 3] ?? 0) +
      (m[a * 3 + 1] ?? 0) * (m[b * 3 + 1] ?? 0) +
      (m[a * 3 + 2] ?? 0) * (m[b * 3 + 2] ?? 0)
    out.set([cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2)], o + 8)
  }
  return out
}

/**
 * A splat renderer for a W×H frame on `device` (host.gpu). Upload splats once in `open`, render
 * with the film's camera in `render(t)`: `[{ color: splats.render(view, projection), alpha:
 * 'premultiplied' }]`. Matrices are column-major, the projection in WebGPU clip space (z 0–1).
 */
export const createSplatRenderer = (device: GPUDevice, o: SplatRendererOptions): SplatRenderer => {
  const format = o.format ?? 'rgba16float'
  const module = device.createShaderModule({ code: SPLATS_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'splatVs' },
    fragment: {
      module,
      entryPoint: 'splatFs',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-strip' },
  })
  const texture = device.createTexture({
    size: [o.width, o.height],
    format,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  const uniforms = device.createBuffer({
    size: 144,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  let data = device.createBuffer({ size: FLOATS * 4, usage: STORAGE })
  let orderBuffer = device.createBuffer({ size: 4, usage: STORAGE })
  let bind: GPUBindGroup | undefined
  let positions = new Float32Array(0)
  let count = 0
  let keys = new Uint32Array(0)
  let tmpKeys = new Uint32Array(0)
  let idx = new Uint32Array(0)
  let tmpIdx = new Uint32Array(0)
  const depth = new Float32Array(1)
  const depthBits = new Uint32Array(depth.buffer)
  let order = new Uint32Array(0)

  const upload = (s: Splats) => {
    const packed = pack(s)
    const limit = device.limits.maxStorageBufferBindingSize
    if (packed.byteLength > limit)
      throw new Error(
        `${s.count} splats need ${packed.byteLength} bytes; this device binds at most ${limit} (${Math.floor(limit / (FLOATS * 4))} splats).`,
      )
    data.destroy()
    orderBuffer.destroy()
    data = device.createBuffer({ size: packed.byteLength, usage: STORAGE })
    device.queue.writeBuffer(data, 0, packed)
    orderBuffer = device.createBuffer({ size: Math.max(1, s.count) * 4, usage: STORAGE })
    positions = s.positions.slice(0, s.count * 3)
    count = s.count
    keys = new Uint32Array(count)
    tmpKeys = new Uint32Array(count)
    idx = new Uint32Array(count)
    tmpIdx = new Uint32Array(count)
    bind = undefined
  }

  /**
   * Back to front: view depth as Float32, keyed so that a far splat sorts first, through a stable
   * LSD radix sort (4 × 8 bits) over indices that start in index order. Splats at or behind the
   * camera plane are left out.
   */
  const sort = (view: ArrayLike<number>) => {
    const v2 = view[2] ?? 0
    const v6 = view[6] ?? 0
    const v10 = view[10] ?? 0
    const v14 = view[14] ?? 0
    let n = 0
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3] ?? 0
      const y = positions[i * 3 + 1] ?? 0
      const z = positions[i * 3 + 2] ?? 0
      depth[0] = -(v2 * x + v6 * y + v10 * z + v14)
      const d = depth[0] ?? 0
      if (!(d > 0)) continue
      // Positive floats sort as their bits; inverted, the farthest comes first.
      keys[n] = ~(depthBits[0] ?? 0) >>> 0
      idx[n] = i
      n++
    }
    const counts = new Uint32Array(256)
    let ka = keys
    let kb = tmpKeys
    let ia = idx
    let ib = tmpIdx
    for (let shift = 0; shift < 32; shift += 8) {
      counts.fill(0)
      for (let i = 0; i < n; i++) {
        const b = ((ka[i] ?? 0) >>> shift) & 255
        counts[b] = (counts[b] ?? 0) + 1
      }
      let sum = 0
      for (let b = 0; b < 256; b++) {
        const c = counts[b] ?? 0
        counts[b] = sum
        sum += c
      }
      for (let i = 0; i < n; i++) {
        const k = ka[i] ?? 0
        const b = (k >>> shift) & 255
        const at = counts[b] ?? 0
        counts[b] = at + 1
        kb[at] = k
        ib[at] = ia[i] ?? 0
      }
      ;[ka, kb] = [kb, ka]
      ;[ia, ib] = [ib, ia]
    }
    order = ia.slice(0, n)
    return order
  }

  const render = (view: ArrayLike<number>, projection: ArrayLike<number>): GPUTexture => {
    const u = new Float32Array(36)
    for (let i = 0; i < 16; i++) {
      u[i] = view[i] ?? 0
      u[16 + i] = projection[i] ?? 0
    }
    u[32] = o.width
    u[33] = o.height
    device.queue.writeBuffer(uniforms, 0, u)
    const sorted = sort(view)
    if (sorted.length) device.queue.writeBuffer(orderBuffer, 0, sorted)
    bind ??= device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: { buffer: data } },
        { binding: 2, resource: { buffer: orderBuffer } },
      ],
    })
    const e = device.createCommandEncoder()
    const pass = e.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    if (sorted.length) {
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bind)
      pass.draw(4, sorted.length)
    }
    pass.end()
    device.queue.submit([e.finish()])
    return texture
  }

  return {
    upload,
    render,
    get order() {
      return order
    },
    destroy: () => {
      texture.destroy()
      data.destroy()
      orderBuffer.destroy()
      uniforms.destroy()
    },
  }
}
