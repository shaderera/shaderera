/*
 * The host's compositor on the GPU (docs/adr/0007): `over` and the depth test as compute
 * passes, then one output pass, read back once. The same rules as `over` (over.ts), in floats.
 */
import type { Light } from './protocol.ts'

/** A layer as the compositor takes it: on the GPU already, or what it uploads. */
export type GpuLayer = {
  /**
   * A texture of the compositor's device, the frame's size, with TEXTURE_BINDING; RGBA bytes; or
   * (in a browser) a bitmap, canvas or video frame at the frame's size, copied on the GPU.
   */
  color: GPUTexture | Uint8Array | Uint8ClampedArray | ImageBitmap | OffscreenCanvas | VideoFrame
  /** Ignored for a bitmap, canvas or video frame: those are copied premultiplied. */
  alpha: 'premultiplied' | 'straight' | 'opaque'
  depth?: { data: Float32Array; soft?: number }
  /** The light a float texture carries: read by the HDR compositor (hdr-compositor.ts) only. */
  light?: Light
}

/**
 * `rgba`: straight RGBA bytes. `rgba64`: straight RGBA at 16 bits a channel, little-endian (8 bytes
 * a pixel), from the same half-float accumulator: the precision a 10-bit or 12-bit master and a
 * 16-bit PNG keep, where the layers had it (float textures, or several layers blended). `yuv420p`: the frame matted over black, as Y'CbCr 4:2:0 (BT.709
 * matrix, limited range, chroma sited left as H.264 assumes), planes Y, Cb, Cr: what an mp4
 * encoder takes as is. The code values are converted with no transfer conversion, as ffmpeg's
 * path did (docs/delivery.md).
 */
export type GpuOutput = 'rgba' | 'rgba64' | 'yuv420p'

/** Whether a frame size can come out as `yuv420p` (one thread per 8×2 tile). */
export const yuvFits = (width: number, height: number) => width % 8 === 0 && height % 2 === 0

const WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  // 0 premultiplied, 1 straight, 2 opaque
  alpha: u32,
  // 1: the texture's format decodes sRGB to linear on load; encode it back
  srgb: u32,
  hasDepth: u32,
  soft: f32,
}
@group(0) @binding(0) var<storage, read_write> acc: array<vec2<u32>>;
@group(0) @binding(1) var<storage, read_write> nearest: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var color: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> depth: array<f32>;
@group(0) @binding(5) var<storage, read_write> outWords: array<u32>;

// Infinity (nowhere) as the largest finite distance: WGSL may assume floats are finite.
const FAR = 3.0e38;
fn finite(d: f32) -> f32 {
  if ((bitcast<u32>(d) & 0x7f800000u) == 0x7f800000u) { return FAR; }
  return d;
}
fn toSrgb(c: f32) -> f32 {
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
fn load(i: u32) -> vec4<f32> {
  let v = acc[i];
  return vec4<f32>(unpack2x16float(v.x), unpack2x16float(v.y));
}

@compute @workgroup_size(8, 8)
fn init(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.width || g.y >= P.height) { return; }
  let i = g.y * P.width + g.x;
  acc[i] = vec2<u32>(0u, 0u);
  nearest[i] = FAR;
}

// One layer over what is there: premultiplied in acc, depth-tested where the layer has depth.
@compute @workgroup_size(8, 8)
fn layer(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.width || g.y >= P.height) { return; }
  let i = g.y * P.width + g.x;
  var c = textureLoad(color, vec2<i32>(g.xy), 0);
  if (P.srgb == 1u) { c = vec4<f32>(toSrgb(c.r), toSrgb(c.g), toSrgb(c.b), c.a); }
  var a = c.a;
  if (P.alpha == 2u) { a = 1.0; }
  if (a <= 0.0) { return; }
  var seen = 1.0;
  if (P.hasDepth == 1u) {
    let d = finite(depth[i]);
    let z = nearest[i];
    if (d > z) {
      seen = 0.0;
      if (P.soft > 0.0) { seen = max(0.0, 1.0 - (d - z) / P.soft); }
    }
    if (seen == 0.0) { return; }
    if (a >= 1.0 && d < z) { nearest[i] = d; }
  }
  let k = a * seen;
  var src = c.rgb * k;
  if (P.alpha == 0u) { src = c.rgb * seen; }
  let prev = load(i);
  let next = vec4<f32>(min(vec3<f32>(1.0), src + prev.rgb * (1.0 - k)), k + prev.a * (1.0 - k));
  acc[i] = vec2<u32>(pack2x16float(next.rg), pack2x16float(next.ba));
}

fn byte(v: f32) -> u32 { return u32(round(clamp(v, 0.0, 1.0) * 255.0)); }

@compute @workgroup_size(8, 8)
fn rgba(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.width || g.y >= P.height) { return; }
  let i = g.y * P.width + g.x;
  let v = load(i);
  var rgb = vec3<f32>(0.0);
  if (v.a > 0.0) { rgb = v.rgb / v.a; }
  outWords[i] = byte(rgb.r) | (byte(rgb.g) << 8u) | (byte(rgb.b) << 16u) | (byte(v.a) << 24u);
}

fn word16(lo: f32, hi: f32) -> u32 {
  return u32(round(clamp(lo, 0.0, 1.0) * 65535.0)) | (u32(round(clamp(hi, 0.0, 1.0) * 65535.0)) << 16u);
}

@compute @workgroup_size(8, 8)
fn rgba64(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.width || g.y >= P.height) { return; }
  let i = g.y * P.width + g.x;
  let v = load(i);
  var rgb = vec3<f32>(0.0);
  if (v.a > 0.0) { rgb = v.rgb / v.a; }
  outWords[2u * i] = word16(rgb.r, rgb.g);
  outWords[2u * i + 1u] = word16(rgb.b, v.a);
}

// Matted over black: the premultiplied colour.
fn matte(x: u32, y: u32) -> vec3<f32> { return clamp(load(y * P.width + x).rgb, vec3<f32>(0.0), vec3<f32>(1.0)); }
fn luma(c: vec3<f32>) -> u32 {
  return u32(clamp(round(16.0 + 219.0 * dot(c, vec3<f32>(0.2126, 0.7152, 0.0722))), 0.0, 255.0));
}
fn cb(c: vec3<f32>) -> u32 {
  return u32(clamp(round(128.0 + 224.0 * dot(c, vec3<f32>(-0.114572, -0.385428, 0.5))), 0.0, 255.0));
}
fn cr(c: vec3<f32>) -> u32 {
  return u32(clamp(round(128.0 + 224.0 * dot(c, vec3<f32>(0.5, -0.454153, -0.045847))), 0.0, 255.0));
}

// One thread per 8×2 tile: four words of Y, one of Cb, one of Cr (width % 8 == 0, height even).
@compute @workgroup_size(8, 8)
fn yuv(@builtin(global_invocation_id) g: vec3<u32>) {
  let x0 = g.x * 8u;
  let y0 = g.y * 2u;
  if (x0 >= P.width || y0 >= P.height) { return; }
  var cols: array<vec3<f32>, 9>;
  for (var r = 0u; r < 2u; r++) {
    let y = y0 + r;
    for (var w = 0u; w < 2u; w++) {
      var word = 0u;
      for (var b = 0u; b < 4u; b++) {
        word = word | (luma(matte(x0 + w * 4u + b, y)) << (b * 8u));
      }
      outWords[(y * P.width + x0) / 4u + w] = word;
    }
  }
  // Columns x0 - 1 .. x0 + 7, each the mean of the tile's two rows (left edge: clamped).
  for (var k = 0u; k < 9u; k++) {
    let x = max(i32(x0) + i32(k) - 1, 0);
    cols[k] = (matte(u32(x), y0) + matte(u32(x), y0 + 1u)) * 0.5;
  }
  var u = 0u;
  var v = 0u;
  for (var j = 0u; j < 4u; j++) {
    // Sited at even luma columns: [1 2 1] / 4 around column x0 + 2j.
    let c = cols[2u * j] * 0.25 + cols[2u * j + 1u] * 0.5 + cols[2u * j + 2u] * 0.25;
    u = u | (cb(c) << (j * 8u));
    v = v | (cr(c) << (j * 8u));
  }
  let plane = P.width * P.height;
  let at = (y0 / 2u) * (P.width / 2u) + x0 / 2u;
  outWords[(plane + at) / 4u] = u;
  outWords[(plane + plane / 4u + at) / 4u] = v;
}
`

const PARAMS = 32
const ALPHA = { premultiplied: 0, straight: 1, opaque: 2 } as const

/**
 * What the SDR and HDR compositors share on `device` for frames of one size: buffers, bind groups
 * and passes, and each layer's texture and depth, kept per layer index across frames.
 */
export const gpuStage = (device: GPUDevice, width: number, height: number) => {
  const pixels = width * height
  const buffer = (size: number, usage: number) =>
    device.createBuffer({ size: Math.max(4, Math.ceil(size / 4) * 4), usage })
  const STORAGE = GPUBufferUsage.STORAGE
  const none = buffer(4, STORAGE)
  // Per layer index, kept across frames: its params, an upload texture, a depth buffer.
  const params: GPUBuffer[] = []
  const uploads: GPUTexture[] = []
  const depths: GPUBuffer[] = []
  const at = <T>(list: T[], i: number, make: () => T) => {
    list[i] ??= make()
    return list[i] as T
  }
  /** Params slot `i`: a uniform buffer holding `data`. */
  const paramsAt = (i: number, data: ArrayBuffer) => {
    const b = at(params, i, () =>
      buffer(data.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    )
    device.queue.writeBuffer(b, 0, data)
    return b
  }
  const bind = (p: GPUComputePipeline, entries: [number, GPUBindingResource][]) =>
    device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: entries.map(([binding, resource]) => ({ binding, resource })),
    })
  const pass = (
    e: GPUCommandEncoder,
    p: GPUComputePipeline,
    group: GPUBindGroup,
    x: number,
    y: number,
    size = 8,
  ) => {
    const c = e.beginComputePass()
    c.setPipeline(p)
    c.setBindGroup(0, group)
    c.dispatchWorkgroups(Math.ceil(x / size), Math.ceil(y / size))
    c.end()
  }
  const upload = (i: number) =>
    at(uploads, i, () =>
      device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      }),
    )
  /** The layer's texture, and how its alpha is stored there. */
  const textureOf = (layer: GpuLayer, i: number): [GPUTexture, GpuLayer['alpha']] => {
    const { color } = layer
    if (color instanceof Uint8Array || color instanceof Uint8ClampedArray) {
      if (color.length !== pixels * 4)
        throw new Error(
          `A layer has ${color.length} bytes; ${width}x${height} RGBA needs ${pixels * 4}.`,
        )
      const texture = upload(i)
      device.queue.writeTexture(
        { texture },
        color as Uint8Array<ArrayBuffer>,
        { bytesPerRow: width * 4 },
        [width, height],
      )
      return [texture, layer.alpha]
    }
    if (!('usage' in color)) {
      const w = 'displayWidth' in color ? color.displayWidth : color.width
      const h = 'displayHeight' in color ? color.displayHeight : color.height
      if (w !== width || h !== height)
        throw new Error(`A layer's image is ${w}x${h}; the frame is ${width}x${height}.`)
      const texture = upload(i)
      device.queue.copyExternalImageToTexture(
        { source: color },
        { texture, premultipliedAlpha: true },
        [width, height],
      )
      return [texture, 'premultiplied']
    }
    if (color.width !== width || color.height !== height)
      throw new Error(
        `A layer's texture is ${color.width}x${color.height}; the frame is ${width}x${height}.`,
      )
    if ((color.usage & GPUTextureUsage.TEXTURE_BINDING) === 0)
      throw new Error('A GPUTexture layer needs TEXTURE_BINDING in its usage.')
    return [color, layer.alpha]
  }
  /** The layer's depth on the GPU, or an empty buffer when it has none. */
  const depthOf = (layer: GpuLayer, i: number) => {
    if (!layer.depth) return none
    if (layer.depth.data.length !== pixels)
      throw new Error(
        `A layer's depth has ${layer.depth.data.length} values; ${width}x${height} needs ${pixels}.`,
      )
    const depth = at(depths, i, () => buffer(pixels * 4, STORAGE | GPUBufferUsage.COPY_DST))
    device.queue.writeBuffer(depth, 0, layer.depth.data as Float32Array<ArrayBuffer>)
    return depth
  }
  /** Copies `target` to `staging`, submits the encoder, and reads back the first `size` bytes. */
  const readBack = async (
    e: GPUCommandEncoder,
    target: GPUBuffer,
    staging: GPUBuffer,
    size: number,
  ) => {
    e.copyBufferToBuffer(target, 0, staging, 0, target.size)
    device.queue.submit([e.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    try {
      return new Uint8Array(staging.getMappedRange(), 0, size).slice()
    } finally {
      staging.unmap()
    }
  }
  const destroy = () => {
    // Sparse: a layer index has an upload or a depth buffer only if a layer there needed one.
    for (const b of [none, ...params, ...depths]) b?.destroy()
    for (const t of uploads) t?.destroy()
  }
  return { pixels, buffer, paramsAt, bind, pass, textureOf, depthOf, readBack, destroy }
}

/**
 * A compositor for frames of one size on `device` (the device the host gives the source, so a
 * source's own texture needs no copy). One frame at a time.
 */
export const gpuCompositor = (device: GPUDevice, width: number, height: number) => {
  const stage = gpuStage(device, width, height)
  const { pixels, buffer, bind, pass } = stage
  const module = device.createShaderModule({ code: WGSL })
  const pipeline = (entryPoint: string) =>
    device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } })
  const pipelines = {
    init: pipeline('init'),
    layer: pipeline('layer'),
    rgba: pipeline('rgba'),
    rgba64: pipeline('rgba64'),
    yuv: pipeline('yuv'),
  }
  const STORAGE = GPUBufferUsage.STORAGE
  const acc = buffer(pixels * 8, STORAGE)
  const nearest = buffer(pixels * 4, STORAGE)
  const SIZE = { rgba: pixels * 4, rgba64: pixels * 8, yuv420p: (pixels * 3) / 2 }
  // The 16-bit pair is made the first time a frame asks for it.
  const lazy = (make: () => GPUBuffer) => {
    let b: GPUBuffer | undefined
    return { get: () => (b ??= make()), destroy: () => b?.destroy() }
  }
  const deep = {
    out: lazy(() => buffer(SIZE.rgba64, STORAGE | GPUBufferUsage.COPY_SRC)),
    read: lazy(() => buffer(SIZE.rgba64, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)),
  }
  const out = {
    rgba: buffer(pixels * 4, STORAGE | GPUBufferUsage.COPY_SRC),
    yuv420p: buffer((pixels * 3) / 2, STORAGE | GPUBufferUsage.COPY_SRC),
  }
  const read = {
    rgba: buffer(pixels * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
    yuv420p: buffer((pixels * 3) / 2, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
  }
  const paramsOf = (i: number, o: { alpha: number; srgb: boolean; depth?: number }) => {
    const data = new ArrayBuffer(PARAMS)
    new Uint32Array(data, 0, 5).set([
      width,
      height,
      o.alpha,
      o.srgb ? 1 : 0,
      o.depth === undefined ? 0 : 1,
    ])
    new Float32Array(data, 20, 1)[0] = o.depth ?? 0
    return stage.paramsAt(i, data)
  }

  /** Composites `layers` bottom to top and reads the output back. */
  const composite = async (layers: readonly GpuLayer[], output: GpuOutput): Promise<Uint8Array> => {
    if (output === 'yuv420p' && !yuvFits(width, height))
      throw new Error(
        `yuv420p needs a width divisible by 8 and an even height, not ${width}x${height}.`,
      )
    const e = device.createCommandEncoder()
    const base = paramsOf(0, { alpha: 0, srgb: false })
    pass(
      e,
      pipelines.init,
      bind(pipelines.init, [
        [0, { buffer: acc }],
        [1, { buffer: nearest }],
        [2, { buffer: base }],
      ]),
      width,
      height,
    )
    for (const [i, layer] of layers.entries()) {
      const [texture, alpha] = stage.textureOf(layer, i)
      const depth = stage.depthOf(layer, i)
      const p = paramsOf(i + 1, {
        alpha: ALPHA[alpha],
        srgb: texture.format.endsWith('-srgb'),
        depth: layer.depth ? (layer.depth.soft ?? 0) : undefined,
      })
      pass(
        e,
        pipelines.layer,
        bind(pipelines.layer, [
          [0, { buffer: acc }],
          [1, { buffer: nearest }],
          [2, { buffer: p }],
          [3, texture.createView()],
          [4, { buffer: depth }],
        ]),
        width,
        height,
      )
    }
    const target = output === 'rgba64' ? deep.out.get() : out[output]
    const staging = output === 'rgba64' ? deep.read.get() : read[output]
    const pipe = pipelines[output === 'yuv420p' ? 'yuv' : output]
    const group = bind(pipe, [
      [0, { buffer: acc }],
      [2, { buffer: base }],
      [5, { buffer: target }],
    ])
    if (output === 'yuv420p') pass(e, pipe, group, width / 8, height / 2)
    else pass(e, pipe, group, width, height)
    return stage.readBack(e, target, staging, SIZE[output])
  }

  const destroy = () => {
    for (const b of [acc, nearest, out.rgba, out.yuv420p, read.rgba, read.yuv420p]) b.destroy()
    deep.out.destroy()
    deep.read.destroy()
    stage.destroy()
  }
  return { width, height, composite, destroy }
}
export type GpuCompositor = ReturnType<typeof gpuCompositor>
