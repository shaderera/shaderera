/// <reference types="@webgpu/types" preserve="true" />
// io.video's yuv420p planes to RGBA (ADR 0027, 2): one integer formula, in TypeScript
// (yuv420pToRgba, the reference) and in WGSL (videoTexture), so both hosts give the same bytes.
import type { Footage, VideoColour } from './protocol.ts'

/** Kr and Kb of each matrix. */
const K = {
  bt601: [0.299, 0.114],
  bt709: [0.2126, 0.0722],
  bt2020nc: [0.2627, 0.0593],
} as const

/**
 * The conversion's integers: luma's offset and scale, and the four chroma terms, each scaled by
 * 2^16 (16 fractional bits).
 */
const coefficients = (colour: VideoColour) => {
  const [kr, kb] = K[colour.matrix]
  const kg = 1 - kr - kb
  const limited = colour.range === 'limited'
  const sy = limited ? 255 / 219 : 1
  const sc = limited ? 255 / 224 : 1
  const fixed = (x: number) => Math.round(x * 65536)
  return {
    y0: limited ? 16 : 0,
    y: fixed(sy),
    rv: fixed(2 * (1 - kr) * sc),
    gu: fixed(((2 * kb * (1 - kb)) / kg) * sc),
    gv: fixed(((2 * kr * (1 - kr)) / kg) * sc),
    bu: fixed(2 * (1 - kb) * sc),
  }
}

/**
 * Chroma sited co-sited (`true`) or between luma samples, across and down: `left` is co-sited
 * across and between rows, `center` between both ways, `topleft` co-sited both ways.
 */
const cosited = (chroma: VideoColour['chroma']) => ({
  across: chroma !== 'center',
  down: chroma === 'topleft',
})

/**
 * Frame bytes in `yuv420p` (I420, tight) to straight, opaque RGBA, sRGB code values, full range:
 * the reference `videoTexture` is held to. Chroma is upsampled bilinearly from where `colour.chroma`
 * sites it, edges clamped (weights in quarters). In integers: the sum carries 20 fractional bits
 * (16 of the coefficients, 4 of the chroma weights), rounded half up and clamped to 0–255.
 */
export const yuv420pToRgba = (
  planes: Uint8Array,
  width: number,
  height: number,
  colour: VideoColour,
): Uint8Array => {
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  if (planes.length !== width * height + 2 * cw * ch)
    throw new Error(
      `yuv420p at ${width}×${height} is ${width * height + 2 * cw * ch} bytes, not ${planes.length}.`,
    )
  const c = coefficients(colour)
  const site = cosited(colour.chroma)
  const cb = width * height
  const cr = cb + cw * ch
  const out = new Uint8Array(width * height * 4)
  const taps = (i: number, n: number, co: boolean): [number, number, number, number] => {
    const j = i >> 1
    const clamp = (k: number) => Math.min(n - 1, Math.max(0, k))
    if (co) return i & 1 ? [j, 2, clamp(j + 1), 2] : [j, 4, j, 0]
    return [j, 3, clamp(i & 1 ? j + 1 : j - 1), 1]
  }
  const round = (sum: number) => Math.min(255, Math.max(0, (sum + (1 << 19)) >> 20))
  for (let y = 0; y < height; y++) {
    const [r0, wr0, r1, wr1] = taps(y, ch, site.down)
    for (let x = 0; x < width; x++) {
      const [c0, wc0, c1, wc1] = taps(x, cw, site.across)
      // Chroma × 16, at this pixel.
      const at = (base: number) =>
        wr0 *
          (wc0 * (planes[base + r0 * cw + c0] as number) +
            wc1 * (planes[base + r0 * cw + c1] as number)) +
        wr1 *
          (wc0 * (planes[base + r1 * cw + c0] as number) +
            wc1 * (planes[base + r1 * cw + c1] as number))
      const u = at(cb) - 2048
      const v = at(cr) - 2048
      const l = c.y * ((planes[y * width + x] as number) - c.y0) * 16
      const p = (y * width + x) * 4
      out[p] = round(l + c.rv * v)
      out[p + 1] = round(l - c.gu * u - c.gv * v)
      out[p + 2] = round(l + c.bu * u)
      out[p + 3] = 255
    }
  }
  return out
}

/** The same formula as yuv420pToRgba, one invocation a pixel. */
const WGSL = /* wgsl */ `
struct U { y0: i32, y: i32, rv: i32, gu: i32, gv: i32, bu: i32, across: u32, down: u32 }
@group(0) @binding(0) var py: texture_2d<u32>;
@group(0) @binding(1) var pu: texture_2d<u32>;
@group(0) @binding(2) var pv: texture_2d<u32>;
@group(0) @binding(3) var out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<uniform> u: U;

// The two samples and their weights (quarters) for luma index i of n chroma samples.
fn taps(i: i32, n: i32, co: bool) -> vec4i {
  let j = i >> 1u;
  let odd = (i & 1) == 1;
  if (co) {
    if (odd) { return vec4i(j, 2, min(n - 1, j + 1), 2); }
    return vec4i(j, 4, j, 0);
  }
  if (odd) { return vec4i(j, 3, min(n - 1, j + 1), 1); }
  return vec4i(j, 3, max(0, j - 1), 1);
}

fn at(p: texture_2d<u32>, r: vec4i, c: vec4i) -> i32 {
  let a = i32(textureLoad(p, vec2i(c.x, r.x), 0).r);
  let b = i32(textureLoad(p, vec2i(c.z, r.x), 0).r);
  let d = i32(textureLoad(p, vec2i(c.x, r.z), 0).r);
  let e = i32(textureLoad(p, vec2i(c.z, r.z), 0).r);
  return r.y * (c.y * a + c.w * b) + r.w * (c.y * d + c.w * e);
}

fn round8(sum: i32) -> f32 {
  return f32(clamp((sum + (1 << 19u)) >> 20u, 0, 255)) / 255.0;
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(py));
  let q = vec2i(id.xy);
  if (q.x >= size.x || q.y >= size.y) { return; }
  let cs = vec2i(textureDimensions(pu));
  let r = taps(q.y, cs.y, u.down == 1u);
  let c = taps(q.x, cs.x, u.across == 1u);
  let cb = at(pu, r, c) - 2048;
  let cr = at(pv, r, c) - 2048;
  let l = u.y * (i32(textureLoad(py, q, 0).r) - u.y0) * 16;
  textureStore(out, q, vec4f(round8(l + u.rv * cr), round8(l - u.gu * cb - u.gv * cr), round8(l + u.bu * cb), 1.0));
}
`

/**
 * A clip's frames as an `rgba8unorm` texture at its size (ADR 0027, 2): `frame(i)` asks for
 * `yuv420p`, uploads the three planes and converts them in a WGSL compute pass with the clip's
 * `colour`, in integers, so every WebGPU implementation gives the same bytes as `yuv420pToRgba`.
 * Straight, opaque, sRGB code values, full range; usage `TEXTURE_BINDING | STORAGE_BINDING |
 * COPY_SRC`, so a clip at the frame's size can be a layer as it is.
 *
 * Ownership: the helper owns its textures. The texture `frame(i)` returns stays valid until the
 * next `frame()` or `destroy()`: a film that holds two frames at once makes two helpers.
 */
export const videoTexture = (device: GPUDevice, clip: Footage) => {
  const { width, height } = clip
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  const plane = (w: number, h: number) =>
    device.createTexture({
      size: [w, h],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
  const planes = [plane(width, height), plane(cw, ch), plane(cw, ch)] as const
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  })
  const c = coefficients(clip.colour)
  const site = cosited(clip.colour.chroma)
  const uniform = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(
    uniform,
    0,
    new Int32Array([c.y0, c.y, c.rv, c.gu, c.gv, c.bu, +site.across, +site.down]),
  )
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: 'main' },
  })
  const bindings = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      ...planes.map((t, binding) => ({ binding, resource: t.createView() })),
      { binding: 3, resource: texture.createView() },
      { binding: 4, resource: { buffer: uniform } },
    ],
  })
  return {
    /** Frame `index`, converted: the helper's texture, valid until the next call. */
    frame: async (index: number): Promise<GPUTexture> => {
      const bytes = await clip.frame(index, { format: 'yuv420p' })
      if (bytes.length !== width * height + 2 * cw * ch)
        throw new Error(
          `videoTexture: frame ${index} is ${bytes.length} bytes, not yuv420p at ${width}×${height}.`,
        )
      let at = 0
      for (const [t, w, h] of [
        [planes[0], width, height],
        [planes[1], cw, ch],
        [planes[2], cw, ch],
      ] as const) {
        device.queue.writeTexture({ texture: t }, bytes, { offset: at, bytesPerRow: w }, [w, h])
        at += w * h
      }
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindings)
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
      pass.end()
      device.queue.submit([encoder.finish()])
      return texture
    },
    destroy: () => {
      for (const t of planes) t.destroy()
      texture.destroy()
      uniform.destroy()
    },
  }
}
