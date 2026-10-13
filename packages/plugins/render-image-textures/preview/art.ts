// Sixteen artworks for the render-image-textures preview, made in code and written as real PNG
// files' bytes (fast-png), in portrait, landscape and square: generative black-and-white
// compositions with a little pastel, each labelled with its number and size. The preview hands the
// bytes to the item's loader exactly as files read from disk.

import { encode } from 'fast-png'
import { FONT } from '../../previews/src/preview.ts'

type Ctx = OffscreenCanvasRenderingContext2D
export type Art = { path: string; width: number; height: number; bytes: Uint8Array }

const SIZES: [number, number][] = [
  [384, 576],
  [576, 384],
  [480, 480],
  [384, 576],
  [576, 384],
  [480, 480],
  [432, 576],
  [576, 432],
]
const PEACH = '#ffc4a8'
const LILAC = '#bfb0ff'

const rnd = (i: number, k: number) => {
  const x = Math.sin(i * 91.7 + k * 37.3) * 43758.5453
  return x - Math.floor(x)
}

const STYLES: ((ctx: Ctx, w: number, h: number, i: number) => void)[] = [
  // A burst of lines from a point off centre.
  (ctx, w, h, i) => {
    const cx = w * (0.3 + 0.4 * rnd(i, 1))
    const cy = h * (0.3 + 0.4 * rnd(i, 2))
    ctx.strokeStyle = '#fff'
    for (let k = 0; k < 140; k++) {
      const a = (k / 140) * Math.PI * 2
      const r = Math.max(w, h) * (0.3 + 0.7 * rnd(i, k + 3))
      ctx.lineWidth = 0.6 + 1.6 * rnd(i, k + 400)
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      ctx.stroke()
    }
  },
  // Halftone dots growing across the frame.
  (ctx, w, h, i) => {
    const step = 16
    ctx.fillStyle = '#fff'
    for (let y = step / 2; y < h; y += step)
      for (let x = step / 2; x < w; x += step) {
        const v = 0.5 + 0.5 * Math.sin(x * 0.012 + y * 0.02 + i)
        ctx.beginPath()
        ctx.arc(x, y, (step / 2) * v ** 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
  },
  // One huge letter.
  (ctx, w, h, i) => {
    const letter = 'SHADERAPLUGINGTX'[i] ?? 'A'
    ctx.fillStyle = '#fff'
    ctx.font = `${Math.min(w, h) * 1.05}px "${FONT.monoBold}"`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(letter, w / 2, h * 0.52)
  },
  // Stacked sine lines.
  (ctx, w, h, i) => {
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    for (let k = 0; k < 28; k++) {
      const y0 = (k + 0.5) * (h / 28)
      ctx.beginPath()
      for (let x = 0; x <= w; x += 4) {
        const y = y0 + Math.sin(x * 0.02 + k * 0.4 + i) * 14 * Math.sin((x / w) * Math.PI)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  },
  // Concentric squares, one in lilac.
  (ctx, w, h, i) => {
    const n = 14
    for (let k = 0; k < n; k++) {
      const s = 1 - k / n
      ctx.strokeStyle = k === 5 + (i % 4) ? LILAC : '#fff'
      ctx.lineWidth = 3
      ctx.strokeRect((w * (1 - s)) / 2, (h * (1 - s)) / 2, w * s, h * s)
    }
  },
  // A dither field: pixels on with a probability that sweeps across.
  (ctx, w, h, i) => {
    ctx.fillStyle = '#fff'
    for (let y = 0; y < h; y += 3)
      for (let x = 0; x < w; x += 3) {
        const v = (x / w) * 0.7 + 0.3 * Math.sin(y * 0.03 + i)
        if (rnd(x * 7 + i, y) < v) ctx.fillRect(x, y, 2, 2)
      }
  },
  // Diagonal stripes cut by a circle.
  (ctx, w, h, i) => {
    ctx.save()
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.38, 0, Math.PI * 2)
    ctx.clip()
    ctx.strokeStyle = i === 6 ? PEACH : '#fff'
    ctx.lineWidth = 7
    for (let k = -h; k < w + h; k += 18) {
      ctx.beginPath()
      ctx.moveTo(k, 0)
      ctx.lineTo(k - h, h)
      ctx.stroke()
    }
    ctx.restore()
  },
  // A grid of crosses round one small pastel disc.
  (ctx, w, h, i) => {
    const g = ctx.createLinearGradient(w * 0.35, h * 0.35, w * 0.65, h * 0.65)
    g.addColorStop(0, PEACH)
    g.addColorStop(1, LILAC)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(w * (0.35 + 0.3 * rnd(i, 9)), h * 0.45, Math.min(w, h) * 0.16, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    for (let y = 40; y < h; y += 48)
      for (let x = 40; x < w; x += 48) {
        ctx.beginPath()
        ctx.moveTo(x - 6, y)
        ctx.lineTo(x + 6, y)
        ctx.moveTo(x, y - 6)
        ctx.lineTo(x, y + 6)
        ctx.stroke()
      }
  },
]

/** The sixteen artworks, as PNG bytes under made-up project paths. */
export const makeArt = (canvas: (w: number, h: number) => OffscreenCanvas): Art[] =>
  Array.from({ length: 16 }, (_, i) => {
    const [w, h] = SIZES[(i * 3) % SIZES.length] as [number, number]
    const c = canvas(w, h)
    const ctx = c.getContext('2d') as Ctx
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    STYLES[(i + (i >> 3)) % STYLES.length]?.(ctx, w, h, i)
    // The label: its number and size, in a black tab.
    const label = `IMG ${String(i + 1).padStart(2, '0')}  ${w}×${h}`
    ctx.font = `15px "${FONT.mono}"`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, h - 28, ctx.measureText(label).width + 20, 28)
    ctx.fillStyle = '#fff'
    ctx.fillText(label, 10, h - 9)
    const data = ctx.getImageData(0, 0, w, h).data
    const bytes = encode({
      width: w,
      height: h,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      channels: 4,
    })
    return {
      path: `assets/art/img-${String(i + 1).padStart(2, '0')}.png`,
      width: w,
      height: h,
      bytes,
    }
  })
