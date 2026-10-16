// A vignette over a finished frame, one WebGPU pass: a texture of host.gpu or a Canvas2D canvas in,
// an opaque texture out. The edges go towards a colour (black by default) in linear light, as a
// lens darkens them; round, or following the frame's own shape, or round an ellipse of a given
// size (a spotlight); from any centre.

import type { Host } from '@shaderera/core'
import { VIGNETTE_WGSL } from './vignette.wgsl.ts'

export type VignetteParams = {
  /** How far the corners go towards the colour, 0–1. */
  amount?: number
  /** Where the falloff starts: 0 at the centre, 1 at the corners (or at the edge of `size`). */
  start?: number
  /** 1 a circle, 0 an ellipse of the frame's proportions. */
  roundness?: number
  /** The centre in px; the frame's centre when left out. */
  centre?: readonly [number, number]
  /**
   * The radii in px of an ellipse the falloff ends at, in place of the frame's corners; at 0 it is
   * closed and everything dims.
   */
  size?: readonly [number, number]
  /** The colour the edges go towards, as display values 0–1. */
  colour?: readonly [number, number, number]
}

/** The vignette for a W×H frame. */
export const createVignette = (host: Host, o: { width: number; height: number }) => {
  const device = host.gpu
  if (!device) throw new Error('look-vignette needs WebGPU (host.gpu)')
  const module = device.createShaderModule({ code: VIGNETTE_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'vignetteFs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 48,
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
  // A canvas is uploaded here first.
  const upload = device.createTexture({
    size: [o.width, o.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const outView = out.createView()
  const groups = new WeakMap<GPUTexture, GPUBindGroup>()
  const groupOf = (texture: GPUTexture) => {
    let g = groups.get(texture)
    if (!g) {
      g = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: texture.createView() },
        ],
      })
      groups.set(texture, g)
    }
    return g
  }

  return {
    /**
     * The frame in `source` with the vignette, as an opaque texture of host.gpu at the frame's
     * size. Return it as a layer: { color, alpha: 'opaque' }. The texture is reused on every call.
     */
    apply(source: GPUTexture | OffscreenCanvas, p: VignetteParams = {}): GPUTexture {
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
      const [cx, cy] = p.centre ?? [o.width / 2, o.height / 2]
      const [rx, ry] = p.size ?? [0, 0]
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([
          p.amount ?? 0.4,
          p.start ?? 0.35,
          p.roundness ?? 1,
          p.size ? 1 : 0,
          cx,
          cy,
          rx,
          ry,
          ...(p.colour ?? [0, 0, 0]),
          0,
        ]),
      )
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: outView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
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
      out.destroy()
      upload.destroy()
      uniforms.destroy()
    },
  }
}
