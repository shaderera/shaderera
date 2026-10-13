// Screen looks: ASCII, halftone, ordered dither, heat, contours, pixels, inverse, and a row glitch
// with pixel sorting, as one WebGPU pass over a finished frame: a GPU texture of host.gpu or a
// Canvas2D canvas. The result is a texture the host composites as a layer. Change the look on the
// beat for "a medium a 1/16".

import type { Host } from '@shaderera/core'
import { LOOKS_WGSL } from './looks.wgsl.ts'

export type LookName =
  | 'none'
  | 'ascii'
  | 'halftone'
  | 'dither'
  | 'heat'
  | 'contours'
  | 'pixels'
  | 'inverse'
export const LOOKS: readonly LookName[] = [
  'none',
  'ascii',
  'halftone',
  'dither',
  'heat',
  'contours',
  'pixels',
  'inverse',
]

export type LookParams = {
  look?: LookName
  /** How much of the look, 0–1, over the plain frame. */
  amount?: number
  /** Cell size in px for halftone and pixels. */
  cell?: number
  /** Share of rows thrown sideways (0 for none, 0.3 is a hard glitch). */
  glitch?: number
  /** Share of thrown rows that are also sorted. */
  sort?: number
  /** How far a thrown row moves, as a share of the width. */
  throw?: number
  vignette?: number
  grain?: number
  /** Changes the glitch's rows and the grain; pass options.frame so they change every frame. */
  seed?: number
}

const ATLAS_W = 160
const ATLAS_H = 108

/**
 * The looks pass for a W×H frame. `face` is a monospace family registered with host.io.font, for
 * the ASCII glyphs.
 */
export const createLooks = (host: Host, o: { width: number; height: number; face: string }) => {
  const device = host.gpu
  if (!device) throw new Error('look-screen-passes needs WebGPU (host.gpu)')
  const module = device.createShaderModule({ code: LOOKS_WGSL })
  const format: GPUTextureFormat = 'rgba8unorm'
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'lookFs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

  // The ASCII glyphs, 16 to a row, 10 × 18 px each, from space to ~.
  const canvas = host.io.canvas(ATLAS_W, ATLAS_H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H)
  ctx.fillStyle = '#fff'
  ctx.font = `15px "${o.face}"`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (let c = 32; c < 128; c++)
    ctx.fillText(String.fromCharCode(c), (c % 16) * 10 + 5, Math.floor((c - 32) / 16) * 18 + 9.5)
  const atlas = device.createTexture({
    size: [ATLAS_W, ATLAS_H],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture: atlas },
    new Uint8Array(ctx.getImageData(0, 0, ATLAS_W, ATLAS_H).data),
    { bytesPerRow: ATLAS_W * 4 },
    [ATLAS_W, ATLAS_H],
  )

  const out = device.createTexture({
    size: [o.width, o.height],
    format,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  // A canvas is uploaded here first.
  const upload = device.createTexture({
    size: [o.width, o.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const groups = new WeakMap<GPUTexture, GPUBindGroup>()
  const groupOf = (texture: GPUTexture) => {
    let g = groups.get(texture)
    if (!g) {
      g = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: sampler },
          { binding: 3, resource: atlas.createView() },
        ],
      })
      groups.set(texture, g)
    }
    return g
  }

  return {
    /**
     * The frame in `source` with the look applied, as a texture of host.gpu at the frame's size.
     * Return it as a layer: { color, alpha: 'opaque' }. The texture is reused on every call.
     */
    apply(source: GPUTexture | OffscreenCanvas, p: LookParams = {}): GPUTexture {
      let texture: GPUTexture
      if ('createView' in source) texture = source
      else {
        const c = source.getContext('2d') as OffscreenCanvasRenderingContext2D
        device.queue.writeTexture(
          { texture: upload },
          new Uint8Array(c.getImageData(0, 0, o.width, o.height).data),
          { bytesPerRow: o.width * 4 },
          [o.width, o.height],
        )
        texture = upload
      }
      const mode = LOOKS.indexOf(p.look ?? 'none')
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([
          Math.max(0, mode),
          mode > 0 ? (p.amount ?? 1) : 0,
          p.cell ?? 8,
          (p.seed ?? 0) % 4096,
          p.glitch ?? 0,
          p.sort ?? 0.3,
          p.throw ?? 0.12,
          0,
          p.vignette ?? 0,
          p.grain ?? 0,
          0,
          0,
        ]),
      )
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, groupOf(texture))
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])
      return out
    },
    dispose() {
      for (const t of [atlas, out, upload]) t.destroy()
      uniforms.destroy()
    },
  }
}
