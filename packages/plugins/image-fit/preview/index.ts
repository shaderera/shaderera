// image-fit: a plain still made here (a checker of numbered cells, a grey disc off centre) put into
// a box whose shape breathes from tall to wide and back over the loop. Left, cover: the box filled,
// the crop held on a focus that circles the disc (a red cross). Right, contain: the whole still in
// the same box. Both are drawn through the pyramid. Bottom left, the whole still with the cover
// crop in red; the HUD names the pyramid level each panel draws from (house.ts).

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import {
  contain,
  cover,
  drawFrom,
  type Point,
  pyramid,
  type Rect,
} from '../../previews/src/image/fit.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const STILL = { width: 2400, height: 1600 }
const DISC: Point = [1650, 700]
const SLOT = 456
const LEFT = { x: L, y: 160, width: SLOT, height: SLOT }
const RIGHT = { x: R - SLOT, y: 160, width: SLOT, height: SLOT }
const MAP = { x: L, y: 660, scale: 150 / STILL.height }

const TOP: Word[] = [{ from: 0, to: 6, text: 'COVER' }]
const BOTTOM: Word[] = [{ from: 0, to: 6, text: 'CONTAIN' }]
const NOTES: Word[] = [
  { from: 0, to: 3, text: 'the crop held on its focus, inside the still' },
  { from: 3, to: 6, text: 'drawn from a level at most twice the size' },
]

const imageFit: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`image-fit has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The still: drawn once, a stand-in with nothing in it that moves.
  const still = host.io.canvas(STILL.width, STILL.height)
  const s = still.getContext('2d') as OffscreenCanvasRenderingContext2D
  const cell = 100
  s.font = `22px ${mono}`
  for (let y = 0; y < STILL.height / cell; y++)
    for (let x = 0; x < STILL.width / cell; x++) {
      s.fillStyle = (x + y) % 2 ? '#303030' : '#202020'
      s.fillRect(x * cell, y * cell, cell, cell)
      s.fillStyle = '#5a5a5a'
      s.fillText(`${x}.${y}`, x * cell + 8, y * cell + 28)
    }
  s.strokeStyle = '#fff'
  s.lineWidth = 6
  s.strokeRect(3, 3, STILL.width - 6, STILL.height - 6)
  s.fillStyle = '#9a9a9a'
  s.beginPath()
  s.arc(DISC[0], DISC[1], 260, 0, Math.PI * 2)
  s.fill()
  s.stroke()
  const photo = pyramid(host.io, still)

  /** The box at t: square at 0, tall, square, wide, square; the long side fills the slot. */
  const boxIn = (slot: Rect, t: number): Rect => {
    const aspect = 2 ** (1.3 * Math.sin((2 * Math.PI * t) / duration))
    const w = aspect >= 1 ? slot.width : slot.width * aspect
    const h = aspect >= 1 ? slot.height / aspect : slot.height
    return {
      x: slot.x + (slot.width - w) / 2,
      y: slot.y + (slot.height - h) / 2,
      width: w,
      height: h,
    }
  }
  const focusAt = (t: number): Point => {
    const a = (2 * Math.PI * t) / duration
    return [DISC[0] + 520 * Math.cos(a), DISC[1] + 420 * Math.sin(a)]
  }
  const levelOf = (source: Rect, target: Rect) =>
    Math.max(
      0,
      Math.min(
        photo.levels.length - 1,
        Math.floor(
          Math.log2(
            Math.max(1, Math.min(source.width / target.width, source.height / target.height)),
          ),
        ),
      ),
    )
  const state = (t: number) => {
    const focus = focusAt(t)
    const a = cover(photo, boxIn(LEFT, t), focus)
    const b = contain(photo, boxIn(RIGHT, t))
    return { focus, a, b }
  }

  const cross = ([x, y]: Point, size: number) => {
    ctx.fillStyle = RED
    ctx.fillRect(x - size, y - 1, size * 2, 3)
    ctx.fillRect(x - 1, y - size, 3, size * 2)
  }

  return {
    async render(t, o) {
      const { focus, a, b } = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ctx.strokeRect(LEFT.x, LEFT.y, LEFT.width, LEFT.height)
      ctx.strokeRect(RIGHT.x, RIGHT.y, RIGHT.width, RIGHT.height)

      drawFrom(ctx, photo, a.source, a.target)
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'
      ctx.strokeRect(a.target.x, a.target.y, a.target.width, a.target.height)
      const k = a.target.width / a.source.width
      cross(
        [a.target.x + (focus[0] - a.source.x) * k, a.target.y + (focus[1] - a.source.y) * k],
        14,
      )

      const rb = boxIn(RIGHT, t)
      ctx.setLineDash([6, 6])
      ctx.strokeRect(rb.x, rb.y, rb.width, rb.height)
      ctx.setLineDash([])
      drawFrom(ctx, photo, b.source, b.target)

      const m = MAP.scale
      drawFrom(
        ctx,
        photo,
        { x: 0, y: 0, ...STILL },
        {
          x: MAP.x,
          y: MAP.y,
          width: STILL.width * m,
          height: STILL.height * m,
        },
      )
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      ctx.strokeRect(
        MAP.x + a.source.x * m,
        MAP.y + a.source.y * m,
        a.source.width * m,
        a.source.height * m,
      )
      cross([MAP.x + focus[0] * m, MAP.y + focus[1] * m], 6)

      house.words(TOP, BOTTOM, t, o.frame)
      house.notes(NOTES, t, o.frame)
      house.hud(
        t,
        o.frame,
        `BOX ${a.target.width.toFixed(0)}×${a.target.height.toFixed(0)}   STILL ${STILL.width}×${STILL.height}`,
        `LEVEL ${levelOf(a.source, a.target)} / ${levelOf(b.source, b.target)} OF ${photo.levels.length}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const { focus } = state(t)
      return `focus ${focus[0].toFixed(0)},${focus[1].toFixed(0)}`
    },
    inspect(t) {
      const { focus, a, b } = state(t)
      return { id: 'fit', focus, cover: a, contain: b }
    },
  }
}

export default imageFit
