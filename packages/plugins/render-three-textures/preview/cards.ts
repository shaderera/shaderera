// Sixteen plain grey cards for the render-three-textures preview, numbered, in portrait,
// landscape and square, made in code as decoded images (8-bit straight RGBA, rows top-down), the
// shape io.image gives. The preview hands them to the plugin's loader as io.image would.

import type { DecodedImage } from '@shaderera/core'
import { FONT } from '../../previews/src/preview.ts'

export type Card = { path: string; image: DecodedImage }

const SIZES: [number, number][] = [
  [384, 576],
  [576, 384],
  [480, 480],
  [432, 576],
  [576, 432],
]

/** The sixteen cards, decoded, under made-up project paths. */
export const makeCards = (canvas: (w: number, h: number) => OffscreenCanvas): Card[] =>
  Array.from({ length: 16 }, (_, i) => {
    const [w, h] = SIZES[(i * 3) % SIZES.length] as [number, number]
    const c = canvas(w, h)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    // Two greys, alternating, so neighbouring cells read apart.
    ctx.fillStyle = i % 2 === 0 ? '#5a5a5a' : '#404040'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#a0a0a0'
    ctx.lineWidth = 4
    ctx.strokeRect(14, 14, w - 28, h - 28)
    ctx.fillStyle = '#fff'
    ctx.font = `${Math.round(Math.min(w, h) * 0.5)}px "${FONT.monoBold}"`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1).padStart(2, '0'), w / 2, h / 2)
    ctx.font = `22px "${FONT.mono}"`
    ctx.fillStyle = '#d0d0d0'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(`${w}×${h}`, w / 2, h - 34)
    // A copy: in Node the pixels share the canvas's memory.
    const data = new Uint8Array(ctx.getImageData(0, 0, w, h).data)
    return {
      path: `assets/cards/card-${String(i + 1).padStart(2, '0')}.png`,
      image: { width: w, height: h, bits: 8, data },
    }
  })
