// The row glitch: bands of rows thrown sideways, and some of them pixel sorted (each run of pixels
// within a brightness range sorted by brightness), on the GPU in one compute pass over a frame: a
// texture of host.gpu or a Canvas2D canvas. Pixels move; none is changed, alpha included.

import type { Host } from '@shaderera/core'
import { createCanvasTexture } from '../render/canvas-texture.ts'
import { ROW_GLITCH_WGSL } from './row-glitch.wgsl.ts'

export type RowGlitchParams = {
  /** The share of bands hit, 0–1. */
  rows?: number
  /** How far a hit band is thrown, either way, as a share of the line (it wraps round). */
  shift?: number
  /** The share of hit bands that are also pixel sorted, 0–1. */
  sort?: number
  /** A band's height in px, from to. */
  band?: readonly [number, number]
  /** The brightness, 0–1, of the pixels that sort; the rest stay put and end each run. */
  range?: readonly [number, number]
  /** Dark to bright along the line, or bright to dark. */
  order?: 'ascending' | 'descending'
  /** Along rows, or along columns. */
  axis?: 'rows' | 'columns'
  /** Which bands are hit and how far they go; change it to change the glitch. */
  seed?: number
}

/** The row glitch for a W×H frame. */
export const createRowGlitch = (host: Host, o: { width: number; height: number }) => {
  const device = host.gpu
  if (!device) throw new Error('look-row-glitch needs WebGPU (host.gpu)')
  const module = device.createShaderModule({ code: ROW_GLITCH_WGSL })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'glitchCs' },
  })
  const uniforms = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const out = device.createTexture({
    size: [o.width, o.height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  })
  // A canvas is uploaded first.
  const canvases = createCanvasTexture(host)
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
          { binding: 2, resource: outView },
        ],
      })
      groups.set(texture, g)
    }
    return g
  }

  return {
    /**
     * The frame in `source` glitched, as a texture of host.gpu at the frame's size, its alpha as
     * the source stored it (a canvas: straight). The texture is reused on every call.
     */
    apply(source: GPUTexture | OffscreenCanvas, p: RowGlitchParams = {}): GPUTexture {
      const texture = 'createView' in source ? source : canvases.upload(source)
      const [low, high] = p.range ?? [0.25, 1]
      const [short, tall] = p.band ?? [4, 48]
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([
          p.rows ?? 0.3,
          p.shift ?? 0.1,
          p.sort ?? 0.5,
          (p.seed ?? 0) % 4096,
          short,
          Math.max(short, tall),
          low,
          high,
          p.order === 'descending' ? 1 : 0,
          p.axis === 'columns' ? 1 : 0,
          0,
          0,
        ]),
      )
      const lines = p.axis === 'columns' ? o.width : o.height
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, groupOf(texture))
      pass.dispatchWorkgroups(Math.ceil(lines / 64))
      pass.end()
      device.queue.submit([encoder.finish()])
      return out
    },
    dispose() {
      out.destroy()
      canvases.dispose()
      uniforms.destroy()
    },
  }
}
