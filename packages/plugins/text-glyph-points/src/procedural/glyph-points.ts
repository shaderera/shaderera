// Text as a point set: rasterised once in open, and `count` points picked from its filled pixels
// with a fixed hash, so every run gives the same points. Coordinates are in text widths: x in
// [-0.5, 0.5], y up, centred. Feed them to particles that form a word, a logo or a line.

import type { Host } from '@shaderera/core'

const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
const rnd = (v: number) => hash(v) / 4294967296

export type GlyphPoints = {
  /** x, y pairs in text widths. */
  points: Float32Array
  /** The inked width over the raster height (how wide the text is for its height). */
  aspect: number
  /** Where each character boundary falls, in the same x units: marks[i] is the left edge of character i. */
  marks: number[]
}

/**
 * `text` in `family` (registered with host.io.font first) as `count` points. `weight` is a CSS
 * weight ('600'). `seed` picks a different but equally fixed set.
 */
export const glyphPoints = (
  host: Host,
  o: { text: string; family: string; count?: number; weight?: string; seed?: number },
): GlyphPoints => {
  const count = o.count ?? 1 << 18
  const seed = o.seed ?? 0
  const H = 760
  const fontSize = 620
  const probe = host.io.canvas(8, 8).getContext('2d') as OffscreenCanvasRenderingContext2D
  const font = `${o.weight ?? 'normal'} ${fontSize}px "${o.family}"`
  probe.font = font
  const W = Math.ceil(probe.measureText(o.text).width + fontSize)
  const canvas = host.io.canvas(W, H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#fff'
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(o.text, W / 2, H / 2)
  // Copied: in Node the pixels share the canvas's memory.
  const data = new Uint8Array(ctx.getImageData(0, 0, W, H).data)
  const filled: number[] = []
  let x0 = W
  let x1 = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if ((data[(y * W + x) * 4] ?? 0) > 127) {
        filled.push(y * W + x)
        if (x < x0) x0 = x
        if (x > x1) x1 = x
      }
  if (filled.length === 0)
    throw new Error(`"${o.text}" in "${o.family}" drew nothing; is the font registered?`)
  const width = x1 - x0 + 1
  const cx = (x0 + x1 + 1) / 2
  const left = W / 2 - ctx.measureText(o.text).width / 2
  const chars = [...o.text]
  const marks = chars.map(
    (_, i) => (left + ctx.measureText(chars.slice(0, i).join('')).width - cx) / width,
  )
  const points = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const p = filled[Math.floor(rnd(seed * 7919 + i * 3) * filled.length)] ?? 0
    const px = (p % W) + rnd(seed * 7919 + i * 3 + 1)
    const py = Math.floor(p / W) + rnd(seed * 7919 + i * 3 + 2)
    points[i * 2] = (px - cx) / width
    points[i * 2 + 1] = (H / 2 - py) / width
  }
  return { points, aspect: width / H, marks }
}
