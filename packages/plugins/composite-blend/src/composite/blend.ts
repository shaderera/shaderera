// A layer over a base by a blend mode, one WebGPU pass: the modes of W3C Compositing and Blending
// Level 1 to the letter, plus `add` (Photoshop's Linear Dodge), and the spec's general compositing
// formula. Two pictures in (canvases, or textures that say how their alpha is stored), one
// premultiplied texture out. `blendPixel` gives the same values on the CPU.

import type { Host } from '@shaderera/core'
import { createCanvasTexture } from '../render/canvas-texture.ts'
import { toLinear, toSrgb } from '../render/srgb.ts'
import { BLEND_MODES, BLEND_WGSL } from './blend.wgsl.ts'

export { BLEND_MODES }
export type BlendMode = (typeof BLEND_MODES)[number]

/**
 * A picture at the frame's size: a Canvas2D canvas (straight alpha), or a texture or canvas that
 * says how its alpha is stored, as a protocol layer does.
 */
export type Picture =
  | OffscreenCanvas
  | {
      color: GPUTexture | OffscreenCanvas
      alpha: 'premultiplied' | 'straight' | 'opaque'
    }

export type BlendParams = {
  /** The blend mode. Required: the plugin never picks one. */
  mode: BlendMode
  /** How much of the layer, 0–1: it scales the layer's alpha (the spec's opacity). 1 by default. */
  amount?: number
  /**
   * Where the blend is computed: 'display' (the spec, and what Photoshop and Canvas2D do) or
   * 'linear' light. 'display' by default.
   */
  space?: 'display' | 'linear'
}

const ALPHA = { straight: 0, premultiplied: 1, opaque: 2 } as const

/** The blend for a W×H frame. */
export const createBlend = (host: Host, o: { width: number; height: number }) => {
  const device = host.gpu
  if (!device) throw new Error('composite-blend needs WebGPU (host.gpu)')
  const module = device.createShaderModule({ code: BLEND_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'blendFs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const out = device.createTexture({
    size: [o.width, o.height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  const outView = out.createView()
  // One uploader each: an uploader reuses one texture per size, and both pictures share the size.
  const uploads = [createCanvasTexture(host), createCanvasTexture(host)] as const
  const views = new WeakMap<GPUTexture, GPUTextureView>()
  const viewOf = (t: GPUTexture) => {
    let v = views.get(t)
    if (!v) {
      v = t.createView()
      views.set(t, v)
    }
    return v
  }
  const read = (p: Picture, i: 0 | 1, name: string) => {
    const { color, alpha } = 'getContext' in p ? { color: p, alpha: 'straight' as const } : p
    const texture = 'createView' in color ? color : uploads[i].upload(color)
    if (texture.width !== o.width || texture.height !== o.height)
      throw new Error(
        `composite-blend: the ${name} is ${texture.width}×${texture.height}, not the frame's ${o.width}×${o.height}`,
      )
    return { view: viewOf(texture), alpha: ALPHA[alpha] }
  }

  return {
    /**
     * `layer` over `base` by `mode`, as a premultiplied texture of host.gpu at the frame's size.
     * Return it as a layer: { color, alpha: 'premultiplied' }. The texture is reused on every call.
     */
    apply(base: Picture, layer: Picture, p: BlendParams): GPUTexture {
      const mode = BLEND_MODES.indexOf(p.mode)
      if (mode < 0)
        throw new Error(
          `composite-blend has no mode "${p.mode}"; the modes are ${BLEND_MODES.join(', ')}`,
        )
      const b = read(base, 0, 'base')
      const s = read(layer, 1, 'layer')
      const data = new ArrayBuffer(32)
      new Uint32Array(data, 0, 4).set([mode, p.space === 'linear' ? 1 : 0, b.alpha, s.alpha])
      new Float32Array(data, 16, 1)[0] = p.amount ?? 1
      device.queue.writeBuffer(uniforms, 0, data)
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: b.view },
          { binding: 2, resource: s.view },
        ],
      })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: outView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])
      return out
    },
    dispose() {
      out.destroy()
      for (const u of uploads) u.dispose()
      uniforms.destroy()
    },
  }
}

type Rgb = readonly [number, number, number]
/** Straight colour 0–1 and alpha 0–1. */
export type Rgba = readonly [number, number, number, number]

const hardLight1 = (cb: number, cs: number) =>
  cs <= 0.5 ? cb * 2 * cs : cb + (2 * cs - 1) - cb * (2 * cs - 1)
const colorDodge1 = (cb: number, cs: number) =>
  cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))
const colorBurn1 = (cb: number, cs: number) =>
  cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)
const softLight1 = (cb: number, cs: number) => {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb)
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)
  return cb + (2 * cs - 1) * (d - cb)
}
const lum = (c: Rgb) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
const clipColor = (c: Rgb): Rgb => {
  const l = lum(c)
  const n = Math.min(...c)
  const x = Math.max(...c)
  let o = c
  if (n < 0) o = o.map((v) => l + ((v - l) * l) / (l - n)) as unknown as Rgb
  if (x > 1) o = o.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as unknown as Rgb
  return o
}
const setLum = (c: Rgb, l: number) => {
  const d = l - lum(c)
  return clipColor([c[0] + d, c[1] + d, c[2] + d])
}
const sat = (c: Rgb) => Math.max(...c) - Math.min(...c)
const setSat = (c: Rgb, s: number): Rgb => {
  const n = Math.min(...c)
  const x = Math.max(...c)
  return x > n ? (c.map((v) => ((v - n) * s) / (x - n)) as unknown as Rgb) : [0, 0, 0]
}
const each = (cb: Rgb, cs: Rgb, f: (b: number, s: number) => number): Rgb => [
  f(cb[0], cs[0]),
  f(cb[1], cs[1]),
  f(cb[2], cs[2]),
]

/** The blend function B(Cb, Cs) of a mode, on straight colour 0–1. */
export const blendRgb = (mode: BlendMode, cb: Rgb, cs: Rgb): Rgb => {
  switch (mode) {
    case 'normal':
      return cs
    case 'multiply':
      return each(cb, cs, (b, s) => b * s)
    case 'screen':
      return each(cb, cs, (b, s) => b + s - b * s)
    case 'overlay':
      return each(cb, cs, (b, s) => hardLight1(s, b))
    case 'darken':
      return each(cb, cs, Math.min)
    case 'lighten':
      return each(cb, cs, Math.max)
    case 'color-dodge':
      return each(cb, cs, colorDodge1)
    case 'color-burn':
      return each(cb, cs, colorBurn1)
    case 'hard-light':
      return each(cb, cs, hardLight1)
    case 'soft-light':
      return each(cb, cs, softLight1)
    case 'difference':
      return each(cb, cs, (b, s) => Math.abs(b - s))
    case 'exclusion':
      return each(cb, cs, (b, s) => b + s - 2 * b * s)
    case 'hue':
      return setLum(setSat(cs, sat(cb)), lum(cb))
    case 'saturation':
      return setLum(setSat(cb, sat(cs)), lum(cb))
    case 'color':
      return setLum(cs, lum(cb))
    case 'luminosity':
      return setLum(cb, lum(cs))
    case 'add':
      return each(cb, cs, (b, s) => Math.min(1, b + s))
  }
}

/**
 * One pixel of `apply` on the CPU: straight base and layer in, the premultiplied result out, all
 * 0–1, the same values as the shader.
 */
export const blendPixel = (base: Rgba, layer: Rgba, p: BlendParams): Rgba => {
  const lin = p.space === 'linear'
  const f = (v: number) => (lin ? toLinear(v) : v)
  const cb: Rgb = [f(base[0]), f(base[1]), f(base[2])]
  const cs: Rgb = [f(layer[0]), f(layer[1]), f(layer[2])]
  const ab = base[3]
  const as = layer[3] * Math.min(1, Math.max(0, p.amount ?? 1))
  const B = blendRgb(p.mode, cb, cs)
  const ao = as + ab * (1 - as)
  if (ao <= 0) return [0, 0, 0, 0]
  const c = [0, 1, 2].map((i) => {
    const co =
      as * (1 - ab) * (cs[i] as number) +
      as * ab * (B[i] as number) +
      (1 - as) * ab * (cb[i] as number)
    const v = lin ? toSrgb(co / ao) : co / ao
    return Math.min(1, Math.max(0, v)) * ao
  })
  return [c[0] as number, c[1] as number, c[2] as number, ao]
}
