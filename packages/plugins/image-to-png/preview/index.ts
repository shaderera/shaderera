// image-to-png: a WebP still and a 12-frame GIF made in code (preview/make.ts), converted by the
// plugin's tools/to-png.ts. The picture is the PNGs it wrote, read back through io.image as a film
// reads them: the still on the left, the clip's frames on the right, played twice over the loop,
// and below them all twelve frames in a strip with the one showing boxed in red and a playhead
// running along it.

import type { DecodedImage } from '@shaderera/core'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const DIR = 'assets/to-png'
const FRAMES = 12
/** The two big pictures, side by side, and the strip of frames under them. */
const BIG = { top: 200, width: 468 }
const STRIP = { top: 610, gap: 4 }

const imageToPng: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`image-to-png has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  if (!host.io.image) throw new Error('image-to-png: this host has no io.image')

  /** A decoded PNG on a canvas of its own size, to draw scaled. */
  const sheetOf = (img: DecodedImage) => {
    const c = host.io.canvas(img.width, img.height)
    const cctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    const pixels = cctx.createImageData(img.width, img.height)
    pixels.data.set(img.data)
    cctx.putImageData(pixels, 0, 0)
    return c
  }
  const still = await host.io.image(`${DIR}/still.png`)
  const stillSheet = sheetOf(still)
  const names = Array.from(
    { length: FRAMES },
    (_, i) => `clip-${String(i + 1).padStart(3, '0')}.png`,
  )
  const frames: OffscreenCanvas[] = []
  for (const name of names) frames.push(sheetOf(await host.io.image(`${DIR}/${name}`)))
  const bigH = (BIG.width * still.height) / still.width
  const thumbW = (R - L - (FRAMES - 1) * STRIP.gap) / FRAMES
  const thumbH = (thumbW * still.height) / still.width

  /** The playhead along the strip, 0 to 1, twice over the loop; the frame it is on. */
  const state = (t: number) => {
    const p = ((t / duration) * 2) % 1
    return { p, frame: Math.min(FRAMES - 1, Math.floor(p * FRAMES)) }
  }

  const words: Word[] = [{ from: 0, to: duration, text: 'TO PNG' }]
  const counts: Word[] = [{ from: 0, to: duration, text: `${FRAMES + 1} PNG` }]

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      ctx.font = `14px "${FONT.mono}"`
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#a0a0a0'
      ctx.textAlign = 'left'
      ctx.fillText('still.webp → still.png', L, BIG.top - 12)
      ctx.textAlign = 'right'
      ctx.fillText(`clip.gif → ${names[s.frame]}`, R, BIG.top - 12)
      ctx.drawImage(stillSheet, L, BIG.top, BIG.width, bigH)
      ctx.drawImage(frames[s.frame] as OffscreenCanvas, R - BIG.width, BIG.top, BIG.width, bigH)

      for (const [i, f] of frames.entries())
        ctx.drawImage(f, L + i * (thumbW + STRIP.gap), STRIP.top, thumbW, thumbH)
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      ctx.strokeRect(L + s.frame * (thumbW + STRIP.gap) - 3, STRIP.top - 3, thumbW + 6, thumbH + 6)
      const x = L + s.p * (R - L)
      ctx.fillStyle = RED
      ctx.fillRect(x - 1, STRIP.top + thumbH + 10, 2, 14)

      house.words(words, counts, t, o.frame)
      house.hud(
        t,
        o.frame,
        `${still.width}×${still.height}   ${still.bits} BIT RGBA   FFMPEG`,
        `FRAME ${String(s.frame + 1).padStart(2, '0')} / ${FRAMES}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return names[state(t).frame] ?? ''
    },
    inspect(t) {
      const s = state(t)
      return { id: 'to-png', frame: s.frame, file: names[s.frame] ?? null }
    },
  }
}

export default imageToPng
