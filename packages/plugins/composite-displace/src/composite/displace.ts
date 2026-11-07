// A displacement map, one WebGPU pass: one picture's channels move another's pixels, as After
// Effects' Displacement Map does. Two pictures in (canvases, or textures that say how their alpha
// is stored), one premultiplied texture out, read bilinearly on premultiplied values.

import type { Host } from '@shaderera/core'
import { createCanvasTexture } from '../render/canvas-texture.ts'
import { DISPLACE_WGSL } from './displace.wgsl.ts'

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

const CHANNELS = ['red', 'green', 'blue', 'alpha', 'luma'] as const
export type Channel = (typeof CHANNELS)[number]

/** One axis: which channel of the map moves the source, and the most it moves, in px. */
export type Axis = { channel: Channel; amount: number }

export type DisplaceParams = {
  /** Along x: a map value of 1 moves the source `amount` px right, 0 as far left, 0.5 not at all. */
  x?: Axis
  /** Along y: 1 moves it down, 0 up. */
  y?: Axis
  /** What shows past the frame's edge: the edge pixel ('clamp', default), 'wrap', 'transparent'. */
  edges?: 'clamp' | 'wrap' | 'transparent'
}

const ALPHA = { straight: 0, premultiplied: 1, opaque: 2 } as const
const EDGES = { clamp: 0, wrap: 1, transparent: 2 } as const

/** The displacement for a W×H frame. */
export const createDisplace = (host: Host, o: { width: number; height: number }) => {
  const device = host.gpu
  if (!device) throw new Error('composite-displace needs WebGPU (host.gpu)')
  const module = device.createShaderModule({ code: DISPLACE_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'displaceFs', targets: [{ format: 'rgba8unorm' }] },
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
        `composite-displace: the ${name} is ${texture.width}×${texture.height}, not the frame's ${o.width}×${o.height}`,
      )
    return { view: viewOf(texture), alpha: ALPHA[alpha] }
  }
  const axis = (a: Axis | undefined, name: string) => {
    if (!a) return { channel: 0, amount: 0 }
    const channel = CHANNELS.indexOf(a.channel)
    if (channel < 0)
      throw new Error(
        `composite-displace: ${name}.channel is one of ${CHANNELS.join(', ')}, not "${a.channel}"`,
      )
    if (!Number.isFinite(a.amount))
      throw new Error(`composite-displace: ${name}.amount is a number of px`)
    return { channel, amount: a.amount }
  }

  return {
    /**
     * `source` moved by `map`, as a premultiplied texture of host.gpu at the frame's size. Return
     * it as a layer: { color, alpha: 'premultiplied' }. The texture is reused on every call.
     */
    apply(source: Picture, map: Picture, p: DisplaceParams): GPUTexture {
      if (!p.x && !p.y) throw new Error('composite-displace: give x, y or both')
      const x = axis(p.x, 'x')
      const y = axis(p.y, 'y')
      const edges = EDGES[p.edges ?? 'clamp']
      if (edges === undefined)
        throw new Error(`composite-displace: edges is clamp, wrap or transparent, not "${p.edges}"`)
      const s = read(source, 0, 'source')
      const m = read(map, 1, 'map')
      const data = new ArrayBuffer(32)
      new Float32Array(data, 0, 2).set([x.amount, y.amount])
      new Uint32Array(data, 8, 6).set([edges, s.alpha, x.channel, y.channel, m.alpha, 0])
      device.queue.writeBuffer(uniforms, 0, data)
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
