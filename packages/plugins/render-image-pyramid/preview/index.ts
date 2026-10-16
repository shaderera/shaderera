// render-image-pyramid: a 4800² test card made in code (a zone plate under a grid with each
// cell's coordinates), its pyramid built once, and a square window zooming from the whole card to
// a 360 px crop and back over the loop, every frame drawn with blit. Beside it, the pyramid's
// levels down to 150 px, each drawn with blit too, the one the window reads from outlined in red.

import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { blit, pyramid } from '../../previews/src/render/pyramid.ts'

type Ctx = OffscreenCanvasRenderingContext2D
const SIZE = 4800
const CELL = 400
/** The crop at the deepest point of the zoom, px of the card. */
const DEEPEST = 360
/** Where the zoom goes, on the card. */
const FOCUS = { x: 2600, y: 2200 }
const VIEW = { x: 210, y: 160, size: 620 }
/** The levels beside the window, at 1/30 of their size. */
const LEVELS = { x: 866, y: 160, scale: 1 / 30, gap: 38 }

const renderImagePyramid: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-image-pyramid has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as Ctx
  const house = createHouse(host, ctx)

  // The card: rings that get finer towards the corners, then the grid and its labels.
  const card = host.io.canvas(SIZE, SIZE)
  const c = card.getContext('2d') as Ctx
  const img = c.createImageData(SIZE, SIZE)
  const k = (0.12 * Math.PI) / (SIZE * 0.71)
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const r2 = (x - SIZE / 2) ** 2 + (y - SIZE / 2) ** 2
      const v = 70 + 50 * Math.cos(k * r2)
      const i = (y * SIZE + x) * 4
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  c.putImageData(img, 0, 0)
  c.strokeStyle = '#e8e8e8'
  c.lineWidth = 3
  c.fillStyle = '#f2f2f2'
  c.font = `44px "${FONT.monoBold}"`
  c.textBaseline = 'top'
  for (let y = 0; y < SIZE; y += CELL)
    for (let x = 0; x < SIZE; x += CELL) {
      c.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3)
      c.fillText(`${x / CELL},${y / CELL}`, x + 22, y + 22)
    }
  const pic = pyramid(host.io, card, { min: 150 })

  const state = (t: number) => {
    const zoom = 0.5 - 0.5 * Math.cos((t / duration) * Math.PI * 2)
    const crop = SIZE * (DEEPEST / SIZE) ** zoom
    // From the whole card towards the focus, the crop always inside the card.
    const cx = SIZE / 2 + (FOCUS.x - SIZE / 2) * zoom
    const cy = SIZE / 2 + (FOCUS.y - SIZE / 2) * zoom
    const ratio = crop / VIEW.size
    const level = Math.max(
      0,
      Math.min(pic.levels.length - 1, Math.floor(Math.log2(Math.max(1, ratio)))),
    )
    return { crop, x: cx - crop / 2, y: cy - crop / 2, level }
  }

  const top: Word[] = [{ from: 0, to: duration, text: 'PYRAMID' }]
  const bottom: Word[] = [{ from: 0, to: duration, text: 'BLIT' }]

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      blit(ctx, pic, s.x, s.y, s.crop, s.crop, VIEW.x, VIEW.y, VIEW.size, VIEW.size)
      // The levels at one scale, so each is half the one above.
      let y = LEVELS.y
      pic.levels.forEach((l, i) => {
        const size = l.width * LEVELS.scale
        blit(ctx, pic, 0, 0, SIZE, SIZE, LEVELS.x, y, size, size)
        ctx.strokeStyle = i === s.level ? RED : '#3a3a3a'
        ctx.lineWidth = 2
        ctx.strokeRect(LEVELS.x - 4, y - 4, size + 8, size + 8)
        ctx.font = `13px "${FONT.mono}"`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = i === s.level ? RED : '#8a8a8a'
        ctx.fillText(`${i}  ${l.width} PX`, LEVELS.x - 4, y + size + 10)
        y += size + LEVELS.gap
      })

      house.words(top, bottom, t, o.frame)
      house.hud(
        t,
        o.frame,
        `CROP ${Math.round(s.crop)} PX INTO ${VIEW.size}   FROM LEVEL ${s.level}`,
        `CARD ${SIZE}×${SIZE}   ${pic.levels.length} LEVELS`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return `level ${state(t).level}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'pyramid', crop: s.crop, level: s.level }
    },
  }
}

export default renderImagePyramid
