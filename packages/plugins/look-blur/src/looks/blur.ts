// Blur one frame: Gaussian, bokeh (a disc or a polygon), directional or radial, by an amount each
// pixel takes from shapes, a map and depth. A GPU texture of host.gpu or a Canvas2D canvas in, a
// premultiplied texture out, in linear light between. Any radius costs the same: every kind reads
// a pyramid of the frame built once per call. Motion blur is not this: it is several t averaged.

import type { Host } from '@shaderera/core'
import { createCanvasTexture } from '../render/canvas-texture.ts'
import { BLUR_WGSL, DOWN_WGSL, PREP_WGSL } from './blur.wgsl.ts'

export type BlurKind = 'gaussian' | 'bokeh' | 'directional' | 'radial'
export const BLURS: readonly BlurKind[] = ['gaussian', 'bokeh', 'directional', 'radial']

/** A rounded box, in px from the frame's top left, whose inside takes its own amount. */
export type BlurShape = {
  x: number
  y: number
  width: number
  height: number
  /** The amount inside, 0–1: 0 keeps it sharp (a window), 1 blurs it fully (a censor box). */
  amount?: number
  /** How far outside the edge, in px, the amount takes to ease back to what is under it. */
  feather?: number
  /** Corner radius in px; half the shorter side makes a capsule, or a circle when width = height. */
  round?: number
}

export type BlurParams = {
  kind?: BlurKind
  /**
   * How far a pixel's light reaches at amount 1, in px of the frame: a bokeh disc's radius, a
   * directional or radial smear's reach each way (radial: at the corner farthest from the
   * centre, less nearer it). A Gaussian's σ is half of it.
   */
  radius?: number
  /** The amount where no shape is, 0–1. */
  amount?: number
  /** Up to 8, each painted over the amount below it, in order. */
  shapes?: readonly BlurShape[]
  /** An amount per pixel, its red times its alpha, multiplied in: a texture of host.gpu or a canvas. */
  map?: GPUTexture | OffscreenCanvas
  /**
   * Depth of field: no blur at `focus`, full at `range` from it, either side. `data` is one
   * distance per pixel, row by row, at the frame's size, as a layer's depth.
   */
  depth?: { data: Float32Array; focus: number; range: number }
  /** Directional: radians, 0 along the rows, turning clockwise on screen. */
  angle?: number
  /** Radial: the centre in px; the frame's centre when left out. */
  centre?: readonly [number, number]
  /** Bokeh: 0 for a round disc, 3 or more for a polygon of that many blades. */
  blades?: number
  /** Bokeh: the polygon's turn, in radians. */
  rotation?: number
  /**
   * How much brighter than white near-white pixels are taken to be, so a small light keeps its
   * glow when it spreads: up to 1 + highlights times. 4 for bokeh, 0 for the others.
   */
  highlights?: number
  /** Taps per pixel for bokeh (96), directional and radial (48): more is smoother and slower. */
  taps?: number
  /** How a texture source stores alpha. A canvas is always straight. */
  alpha?: 'premultiplied' | 'straight' | 'opaque'
}

const MAX_SHAPES = 8
const PIXEL = new Uint8Array([255, 255, 255, 255])

/** The blur for a W×H frame. */
export const createBlur = (host: Host, o: { width: number; height: number }) => {
  const device = host.gpu
  if (!device) throw new Error('look-blur needs WebGPU (host.gpu)')
  const { width: W, height: H } = o
  const levels = Math.max(1, Math.min(12, Math.floor(Math.log2(Math.min(W, H)))))
  const pipelineOf = (code: string, entryPoint: string, format: GPUTextureFormat) => {
    const module = device.createShaderModule({ code })
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'fullVs' },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
  }
  const prep = pipelineOf(PREP_WGSL, 'prepFs', 'rgba16float')
  const down = pipelineOf(DOWN_WGSL, 'downFs', 'rgba16float')
  const blur = pipelineOf(BLUR_WGSL, 'blurFs', 'rgba8unorm')
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
  })
  const prepUniforms = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const uniforms = device.createBuffer({
    size: 16 * (5 + 2 * MAX_SHAPES),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // The pyramid: level 0 is the frame in linear light, premultiplied; each level above is half.
  const work = device.createTexture({
    size: [W, H],
    format: 'rgba16float',
    mipLevelCount: levels,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
  const level = Array.from({ length: levels }, (_, k) =>
    work.createView({ baseMipLevel: k, mipLevelCount: 1 }),
  )
  const downGroups = level.slice(0, -1).map((view) =>
    device.createBindGroup({
      layout: down.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: sampler },
      ],
    }),
  )
  const out = device.createTexture({
    size: [W, H],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  const white = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture({ texture: white }, PIXEL, { bytesPerRow: 4 }, [1, 1])
  const noDepth = device.createTexture({
    size: [1, 1],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  })
  const owned: GPUTexture[] = [work, out, white, noDepth]
  const workView = work.createView()
  const outView = out.createView()

  // Canvases are uploaded into textures of their size, the frame and the map each its own.
  const sources = createCanvasTexture(host)
  const maps = createCanvasTexture(host)
  let depthTexture: GPUTexture | undefined
  const depthOf = (data: Float32Array) => {
    if (data.length !== W * H)
      throw new Error(`look-blur: depth has ${data.length} values, not ${W}×${H}`)
    if (!depthTexture) {
      depthTexture = device.createTexture({
        size: [W, H],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      owned.push(depthTexture)
    }
    // Infinity (nowhere) is as far as a float goes: fully out of focus.
    const finite = data.map((z) => (Number.isFinite(z) ? z : 3e38))
    device.queue.writeTexture({ texture: depthTexture }, finite, { bytesPerRow: W * 4 }, [W, H])
    return depthTexture
  }
  // Views are made once per texture, never per frame.
  const views = new WeakMap<GPUTexture, GPUTextureView>()
  const viewOf = (texture: GPUTexture) => {
    let v = views.get(texture)
    if (!v) {
      v = texture.createView()
      views.set(texture, v)
    }
    return v
  }

  const draw = (
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    group: GPUBindGroup,
    view: GPUTextureView,
  ) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.draw(3)
    pass.end()
  }

  return {
    /**
     * The frame in `source` blurred, as a premultiplied texture of host.gpu at the frame's size.
     * Return it as a layer: { color, alpha: 'premultiplied' }. The texture is reused on every call.
     */
    apply(source: GPUTexture | OffscreenCanvas, p: BlurParams = {}): GPUTexture {
      const shapes = p.shapes ?? []
      if (shapes.length > MAX_SHAPES)
        throw new Error(`look-blur takes up to ${MAX_SHAPES} shapes, not ${shapes.length}`)
      const canvas = !('createView' in source)
      const texture = canvas ? sources.upload(source) : source
      const alpha = ['premultiplied', 'straight', 'opaque'].indexOf(
        canvas ? 'straight' : (p.alpha ?? 'premultiplied'),
      )
      const linear = texture.format.endsWith('-srgb') ? 1 : 0
      const kind = p.kind ?? 'gaussian'
      const highlights = p.highlights ?? (kind === 'bokeh' ? 4 : 0)
      device.queue.writeBuffer(prepUniforms, 0, new Float32Array([alpha, linear, highlights, 0]))
      const [cx, cy] = p.centre ?? [W / 2, H / 2]
      const reach = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy))
      const map = p.map && ('createView' in p.map ? p.map : maps.upload(p.map))
      const u = new Float32Array(4 * (5 + 2 * MAX_SHAPES))
      u.set([BLURS.indexOf(kind), p.radius ?? 24, p.amount ?? 1, shapes.length])
      u.set([p.angle ?? 0, cx, cy, reach], 4)
      u.set(
        [
          p.blades ?? 0,
          p.rotation ?? 0,
          Math.max(1, Math.round(p.taps ?? (kind === 'bokeh' ? 96 : 48))),
          0,
        ],
        8,
      )
      u.set([map ? 1 : 0, p.depth ? 1 : 0, p.depth?.focus ?? 0, p.depth?.range ?? 1], 12)
      u.set([levels, alpha, linear, 0], 16)
      shapes.forEach((s, i) => {
        u.set(
          [s.x, s.y, s.width, s.height, s.feather ?? 0, s.round ?? 0, s.amount ?? 0, 0],
          20 + i * 8,
        )
      })
      device.queue.writeBuffer(uniforms, 0, u)
      const prepGroup = device.createBindGroup({
        layout: prep.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: prepUniforms } },
          { binding: 1, resource: viewOf(texture) },
          { binding: 2, resource: sampler },
        ],
      })
      const group = device.createBindGroup({
        layout: blur.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: workView },
          { binding: 2, resource: sampler },
          { binding: 3, resource: viewOf(map ?? white) },
          { binding: 4, resource: viewOf(p.depth ? depthOf(p.depth.data) : noDepth) },
          { binding: 5, resource: viewOf(texture) },
        ],
      })
      const encoder = device.createCommandEncoder()
      draw(encoder, prep, prepGroup, level[0] as GPUTextureView)
      downGroups.forEach((g, k) => {
        draw(encoder, down, g, level[k + 1] as GPUTextureView)
      })
      draw(encoder, blur, group, outView)
      device.queue.submit([encoder.finish()])
      return out
    },
    dispose() {
      for (const t of owned) t.destroy()
      sources.dispose()
      maps.dispose()
      prepUniforms.destroy()
      uniforms.destroy()
    },
  }
}
