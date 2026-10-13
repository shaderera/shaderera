// render-image-textures: sixteen grey numbered cards made in code as PNG bytes (preview/cards.ts),
// decoded by the plugin's pure-JS decoder and packed by its loadAtlas into one 2048² texture. The
// picture is that texture's own pixels, drawn flat, with faint lines at its 512 px cells. The
// camera pans down the atlas and back, and a red box steps from card to card with the rect the
// plugin returned for it. No three.js scene: the plugin needs none to build the atlas.

import type { Host } from '@shaderera/core'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { loadAtlas } from '../../previews/src/three/images.ts'
import { makeCards } from './cards.ts'

const CELL = 512
const COLUMNS = 4
/** The window the atlas is seen through, and its scale in it. */
const VIEW = { top: 140, bottom: 790 }
const SCALE = 0.4
/** Black kept above the atlas at the top of the pan, and below it at the bottom. */
const MARGIN = 14
/** The row of the card the box is on, in each of the 16 steps: down the atlas and back up. */
const ROWS = [0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 2, 2, 1, 1, 0, 0]

const renderImageTextures: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-image-textures has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)

  // The cards as PNG files' bytes, read by the plugin as if from disk.
  const cards = makeCards((w, h) => host.io.canvas(w, h))
  const files = new Map(cards.map((c) => [c.path, c.bytes]))
  const reader = {
    ...host,
    io: {
      ...host.io,
      read: async (path: string) => {
        const bytes = files.get(path)
        if (!bytes) throw new Error(`No card ${path}`)
        return bytes
      },
    },
  } as Host
  const atlas = await loadAtlas(
    reader,
    cards.map((c) => c.path),
    { cell: CELL, columns: COLUMNS },
  )
  const kb = cards.reduce((s, c) => s + c.bytes.length, 0) / 1024

  // The atlas texture's pixels, as the plugin uploads them (rows bottom-up), turned back upright.
  const image = atlas.texture.image as { data: Uint8Array; width: number; height: number }
  const A = image.width
  const sheet = host.io.canvas(A, image.height)
  const sctx = sheet.getContext('2d') as OffscreenCanvasRenderingContext2D
  const pixels = sctx.createImageData(A, image.height)
  const row = A * 4
  for (let y = 0; y < image.height; y++)
    pixels.data.set(
      image.data.subarray((image.height - 1 - y) * row, (image.height - y) * row),
      y * row,
    )
  sctx.putImageData(pixels, 0, 0)

  const D = A * SCALE
  const left = (width - D) / 2
  const overflow = D - (VIEW.bottom - VIEW.top)
  const steps = ROWS.length

  const state = (t: number) => {
    const pan = 0.5 - 0.5 * Math.cos((t / duration) * Math.PI * 2)
    const k = Math.min(steps - 1, Math.floor((t / duration) * steps))
    const card = (ROWS[k] ?? 0) * COLUMNS + (k % COLUMNS)
    return { top: VIEW.top + MARGIN - (overflow + 2 * MARGIN) * pan, card }
  }

  const words: Word[] = [{ from: 0, to: duration, text: 'ATLAS' }]
  const counts: Word[] = [{ from: 0, to: duration, text: '16 PNG' }]

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      ctx.save()
      ctx.beginPath()
      ctx.rect(0, VIEW.top, width, VIEW.bottom - VIEW.top)
      ctx.clip()
      ctx.drawImage(sheet, left, s.top, D, D)
      // The cells the plugin packed into, and the sheet's edge.
      ctx.strokeStyle = '#2c2c2c'
      ctx.lineWidth = 1
      for (let k = 0; k <= COLUMNS; k++) {
        const p = Math.round(k * CELL * SCALE) + 0.5
        ctx.beginPath()
        ctx.moveTo(left + p, s.top)
        ctx.lineTo(left + p, s.top + D)
        ctx.moveTo(left, s.top + p)
        ctx.lineTo(left + D, s.top + p)
        ctx.stroke()
      }
      // The box on one card: the rect the plugin returned for it ([u, v, w, h], v up).
      const r = atlas.rects[s.card]
      if (r) {
        const [u, v, w, h] = r.rect
        const x0 = left + u * D
        const y0 = s.top + (1 - v - h) * D
        ctx.strokeStyle = RED
        ctx.lineWidth = 2
        ctx.strokeRect(x0 - 4, y0 - 4, w * D + 8, h * D + 8)
        const label = `rects[${s.card}]  ${r.rect.map((n) => n.toFixed(3)).join(' ')}`
        ctx.font = `14px "${FONT.mono}"`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        const lw = ctx.measureText(label).width + 12
        const lx = Math.min(R - lw, Math.max(L, x0 - 4))
        ctx.fillStyle = RED
        ctx.fillRect(lx, y0 - 4, lw, 20)
        ctx.fillStyle = '#000'
        ctx.fillText(label, lx + 6, y0 + 11)
      }
      ctx.restore()

      house.words(words, counts, t, o.frame)
      house.hud(
        t,
        o.frame,
        `ATLAS ${A}×${image.height}   CELL ${CELL}   ${kb.toFixed(0)} KB OF PNG`,
        `CARD ${String(s.card + 1).padStart(2, '0')} / 16   ASPECT ${(r?.aspect ?? 1).toFixed(2)}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return `card ${String(state(t).card + 1).padStart(2, '0')}/16`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'atlas', card: s.card, rect: atlas.rects[s.card]?.rect ?? null }
    },
  }
}

export default renderImageTextures
