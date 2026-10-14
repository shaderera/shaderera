// Film grain over a finished frame, one WebGPU pass: a texture of host.gpu or a Canvas2D canvas in,
// an opaque texture out. Gaussian, of a set size, strongest in the mid-tones, mono or colour. The
// seed picks the grain: pass options.frame for grain that lives, a constant for grain that holds.

import type { Host } from '@shaderera/core'
import { GRAIN_WGSL } from './grain.wgsl.ts'

export type GrainParams = {
  /** Its strength: the noise's σ in display values (0.04, 4% of white, by default). */
  amount?: number
  /** A grain's size in px; 1 is a pixel each. */
  size?: number
  /** 0 the same on every channel, 1 each channel its own. */
  colour?: number
  /** How much the grain keeps to the mid-tones, 0–1: at 1, pure black and white stay clean. */
  midtones?: number
  /** The grain's pattern; pass options.frame so it changes every frame. */
  seed?: number
}

/** Film grain for a W×H frame. */
export const createGrain = (host: Host, o: { width: number; height: number }) => {
  const device = host.gpu
  if (!device) throw new Error('look-film-grain needs WebGPU (host.gpu)')
  const module = device.createShaderModule({ code: GRAIN_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'grainFs', targets: [{ format: 'rgba8unorm' }] },
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
     * The frame in `source` with grain, as an opaque texture of host.gpu at the frame's size.
     * Return it as a layer: { color, alpha: 'opaque' }. The texture is reused on every call.
     */
    apply(source: GPUTexture | OffscreenCanvas, p: GrainParams = {}): GPUTexture {
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
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([
          p.amount ?? 0.04,
          p.size ?? 1.5,
          p.colour ?? 0,
          (p.seed ?? 0) % 4096,
          p.midtones ?? 0.7,
          0,
          0,
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
