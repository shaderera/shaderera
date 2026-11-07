// A track matte, one WebGPU pass: one picture's luma or alpha as another's matte, as After Effects'
// track matte does. Two pictures in (canvases, or textures that say how their alpha is stored), one
// premultiplied texture out.

import type { Host } from '@shaderera/core'
import { createCanvasTexture } from '../render/canvas-texture.ts'
import { MATTE_WGSL } from './matte.wgsl.ts'

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

export type MatteParams = {
  /**
   * What of the matte keeps the source. Required. 'luma': its Rec. 709 luma of the display
   * values, times its own alpha, so white keeps and black cuts. 'alpha': its alpha alone.
   */
  channel: 'luma' | 'alpha'
  /** The matte turned over: what it kept is cut and what it cut is kept. */
  invert?: boolean
}

const ALPHA = { straight: 0, premultiplied: 1, opaque: 2 } as const

/** The matte for a W×H frame. */
export const createMatte = (host: Host, o: { width: number; height: number }) => {
  const device = host.gpu
  if (!device) throw new Error('composite-matte needs WebGPU (host.gpu)')
  const module = device.createShaderModule({ code: MATTE_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'matteFs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 16,
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
        `composite-matte: the ${name} is ${texture.width}×${texture.height}, not the frame's ${o.width}×${o.height}`,
      )
    return { view: viewOf(texture), alpha: ALPHA[alpha] }
  }

  return {
    /**
     * `source` kept where `matte` says, as a premultiplied texture of host.gpu at the frame's
     * size. Return it as a layer: { color, alpha: 'premultiplied' }. The texture is reused on
     * every call.
     */
    apply(source: Picture, matte: Picture, p: MatteParams): GPUTexture {
      if (p.channel !== 'luma' && p.channel !== 'alpha')
        throw new Error(`composite-matte: channel is 'luma' or 'alpha', not "${p.channel}"`)
      const s = read(source, 0, 'source')
      const m = read(matte, 1, 'matte')
      device.queue.writeBuffer(
        uniforms,
        0,
        new Uint32Array([p.channel === 'luma' ? 1 : 0, p.invert ? 1 : 0, s.alpha, m.alpha]),
      )
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: s.view },
          { binding: 2, resource: m.view },
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
