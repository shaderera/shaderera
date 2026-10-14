// Screen looks: the frame in another medium (ASCII, halftone, ordered dither, heat, contours,
// pixels, inverse) as one WebGPU pass over a finished frame: a GPU texture of host.gpu or a
// Canvas2D canvas. The result is an opaque texture the host composites as a layer. Every colour
// and number is a parameter; the defaults are ink white on black paper.

import type { Host } from '@shaderera/core'
import { LOOKS_WGSL } from './looks.wgsl.ts'

export type LookName = 'ascii' | 'halftone' | 'dither' | 'heat' | 'contours' | 'pixels' | 'inverse'
export const LOOKS: readonly LookName[] = [
  'ascii',
  'halftone',
  'dither',
  'heat',
  'contours',
  'pixels',
  'inverse',
]

/** A colour as display values, 0–1. */
export type Rgb = readonly [number, number, number]

export type LookParams = {
  look: LookName
  /** How much of the look, 0–1, over the plain frame. */
  amount?: number
  /**
   * Cell size in px: an ASCII cell's width (its height follows the glyphs), a halftone dot's
   * pitch, a pixel block, a dither block. 10, 8, 8 and 1 by default.
   */
  cell?: number
  /** The brightness curve before a look reads it: under 1 lifts the shadows, over 1 sinks them. */
  gamma?: number
  /** What ASCII, halftone, dither and contours draw with; 'source' takes the frame's own colour. */
  ink?: Rgb | 'source'
  /** What they draw on. */
  paper?: Rgb
  /** Halftone: the screen's angle in radians (45° by default, as for black ink). */
  angle?: number
  /** Dither: levels per channel, 2 for one bit. */
  levels?: number
  /** Contours: how many steps of brightness get a line. */
  bands?: number
  /** Contours: a line's width in px. */
  line?: number
  /** Contours: how much of the frame shows under the lines, 0–1. */
  under?: number
  /** Heat: 2 to 8 colours from dark to bright, evenly spaced. */
  palette?: readonly Rgb[]
}

const CELL: Record<LookName, number> = {
  ascii: 10,
  halftone: 8,
  dither: 1,
  heat: 1,
  contours: 1,
  pixels: 8,
  inverse: 1,
}

/** Black through violet, red and orange to white, like a thermal camera. */
export const HEAT: readonly Rgb[] = [
  [0, 0, 0.03],
  [0.22, 0.03, 0.48],
  [0.86, 0.12, 0.38],
  [1, 0.55, 0.08],
  [1, 0.98, 0.86],
]

/** The ASCII glyphs from least ink to most. */
export const RAMP = ' .:-=+*#%@'

/** An atlas slot per glyph, in px: scaled to the cell when drawn. */
const SLOT_W = 32
const SLOT_H = 56

/**
 * The looks pass for a W×H frame. `face` is a monospace family registered with host.io.font, for
 * the ASCII glyphs; `ramp` the glyphs from least ink to most (up to 32).
 */
export const createLooks = (
  host: Host,
  o: { width: number; height: number; face: string; ramp?: string },
) => {
  const device = host.gpu
  if (!device) throw new Error('look-screen-passes needs WebGPU (host.gpu)')
  const ramp = [...(o.ramp ?? RAMP)]
  if (ramp.length < 2 || ramp.length > 32)
    throw new Error(`look-screen-passes: a ramp of 2 to 32 glyphs, not ${ramp.length}`)
  const module = device.createShaderModule({ code: LOOKS_WGSL })
  const format: GPUTextureFormat = 'rgba8unorm'
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'lookFs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 16 * 13,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
  })

  // The ramp's glyphs, one slot each, white on black.
  const aw = SLOT_W * ramp.length
  const canvas = host.io.canvas(aw, SLOT_H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, aw, SLOT_H)
  ctx.fillStyle = '#fff'
  ctx.font = `48px "${o.face}"`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ramp.forEach((g, i) => {
    ctx.fillText(g, i * SLOT_W + SLOT_W / 2, SLOT_H / 2 + 1)
  })
  // Mipmapped, so a cell far smaller than a slot still shows its glyph rather than its aliasing.
  const mips = Math.floor(Math.log2(SLOT_W)) - 1
  const atlas = device.createTexture({
    size: [aw, SLOT_H],
    format: 'rgba8unorm',
    mipLevelCount: mips,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  for (let level = 0; level < mips; level++) {
    const w = Math.max(1, aw >> level)
    const h = Math.max(1, SLOT_H >> level)
    const mip = host.io.canvas(w, h)
    const m = mip.getContext('2d') as OffscreenCanvasRenderingContext2D
    m.imageSmoothingQuality = 'high'
    m.drawImage(canvas as unknown as CanvasImageSource, 0, 0, w, h)
    device.queue.writeTexture(
      { texture: atlas, mipLevel: level },
      new Uint8Array(m.getImageData(0, 0, w, h).data),
      { bytesPerRow: w * 4 },
      [w, h],
    )
  }

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
     * The frame in `source` in another medium, as an opaque texture of host.gpu at the frame's
     * size. Return it as a layer: { color, alpha: 'opaque' }. The texture is reused on every call.
     */
    apply(source: GPUTexture | OffscreenCanvas, p: LookParams): GPUTexture {
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
      const mode = LOOKS.indexOf(p.look)
      if (mode < 0) throw new Error(`look-screen-passes has no look "${p.look}"`)
      const palette = p.palette ?? HEAT
      if (palette.length < 2 || palette.length > 8)
        throw new Error(`look-screen-passes: a palette of 2 to 8 colours, not ${palette.length}`)
      const cell = p.cell ?? CELL[p.look]
      const ink = p.ink ?? [1, 1, 1]
      const u = new Float32Array(4 * 13)
      u.set([mode, p.amount ?? 1, cell, p.gamma ?? 1])
      u.set(ink === 'source' ? [1, 1, 1, 1] : [...ink, 0], 4)
      u.set([...(p.paper ?? [0, 0, 0]), p.angle ?? Math.PI / 4], 8)
      u.set([p.levels ?? 2, p.bands ?? 10, p.line ?? 1.5, p.under ?? 0], 12)
      // An ASCII cell keeps the slot's proportions.
      u.set([ramp.length, Math.round((cell * SLOT_H) / SLOT_W), palette.length, 0], 16)
      palette.forEach((c, i) => {
        u.set([...c, 1], 20 + i * 4)
      })
      device.queue.writeBuffer(uniforms, 0, u)
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
