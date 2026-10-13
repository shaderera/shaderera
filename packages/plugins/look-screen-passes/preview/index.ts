// look-screen-passes: a plain grey test card on black (a step wedge, a ring and a box turning once
// a loop, drawn with Canvas2D) and the plugin's one pass over it. In the 'all' state the pass
// changes every 20 frames with a hard cut: none, ascii, halftone, dither, heat, contours, pixels,
// inverse and the row glitch. A state holds one pass; 'off' is the card with no pass. The pass is
// the big word top left, in the house style (house.ts) over the picture.

import type { Layer } from '@shaderera/core'
import { createHouse, type Word } from '../../previews/src/house.ts'
import { createLooks, type LookName, type LookParams } from '../../previews/src/looks/looks.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

type Segment = { id: string; look: LookName; word: string; note: string; params?: LookParams }

/** The passes in order, a ninth of the loop each; the first follows the last. */
const SEGMENTS: Segment[] = [
  { id: 'source', look: 'none', word: 'SOURCE', note: 'the card, before any pass' },
  { id: 'ascii', look: 'ascii', word: 'ASCII', note: 'a glyph a cell, by its brightness' },
  {
    id: 'halftone',
    look: 'halftone',
    word: 'HALFTONE',
    note: 'dots as big as the light under them',
    params: { cell: 18 },
  },
  { id: 'dither', look: 'dither', word: 'DITHER', note: 'an ordered threshold, one bit deep' },
  { id: 'heat', look: 'heat', word: 'HEAT', note: 'brightness as a thermal palette' },
  { id: 'contours', look: 'contours', word: 'CONTOURS', note: 'lines where the light crosses' },
  {
    id: 'pixels',
    look: 'pixels',
    word: 'PIXELS',
    note: 'blocks of 27 px, each its mean',
    params: { cell: 27 },
  },
  { id: 'inverse', look: 'inverse', word: 'INVERSE', note: 'every value turned over' },
  {
    id: 'glitch',
    look: 'none',
    word: 'GLITCH',
    note: 'rows thrown sideways, some sorted',
    params: { glitch: 0.34, sort: 0.6, throw: 0.2 },
  },
]

/** The test card: its square, and the centre of the turning box. */
const CARD = { x: 240, y: 150, size: 600 }
const BOX = { x: 540, y: 410, size: 290 }
const STEPS = 11

const lookScreenPasses: OpenPreview = async (host, stateId) => {
  // 'all' cycles through every pass; a state holds one ('off' is the card with no pass).
  const segments =
    stateId === 'all'
      ? SEGMENTS
      : SEGMENTS.filter((s) => s.id === (stateId === 'off' ? 'source' : stateId))
  if (segments.length === 0) throw new Error(`look-screen-passes has no state "${stateId}"`)
  const first = segments[0] as Segment
  if (!host.gpu) throw new Error('The look-screen-passes preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const step = duration / segments.length
  const looks = createLooks(host, { width, height, face: FONT.mono })
  const source = host.io.canvas(width, height)
  const sctx = source.getContext('2d') as OffscreenCanvasRenderingContext2D
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const passWords: Word[] = segments.map((s, i) => ({
    from: i * step,
    to: (i + 1) * step,
    text: s.word,
  }))
  const passNotes: Word[] = segments.map((s, i) => ({ ...(passWords[i] as Word), text: s.note }))
  const cardWords: Word[] = [{ from: 0, to: duration, text: 'TEST CARD' }]

  /** The card at t: a grey step wedge, a ring, and a box with a grey ramp, turning once a loop. */
  const card = (t: number) => {
    sctx.fillStyle = '#000'
    sctx.fillRect(0, 0, width, height)
    sctx.fillStyle = '#1e1e1e'
    sctx.fillRect(CARD.x, CARD.y, CARD.size, CARD.size)
    const w = CARD.size / STEPS
    for (let k = 0; k < STEPS; k++) {
      const v = Math.round((255 * k) / (STEPS - 1))
      sctx.fillStyle = `rgb(${v},${v},${v})`
      sctx.fillRect(CARD.x + k * w, CARD.y + CARD.size - 90, w + 0.5, 90)
    }
    sctx.strokeStyle = '#8c8c8c'
    sctx.lineWidth = 8
    sctx.beginPath()
    sctx.arc(BOX.x, BOX.y, 220, 0, Math.PI * 2)
    sctx.stroke()
    sctx.save()
    sctx.translate(BOX.x, BOX.y)
    sctx.rotate((t / duration) * Math.PI * 2)
    const ramp = sctx.createLinearGradient(-BOX.size / 2, 0, BOX.size / 2, 0)
    ramp.addColorStop(0, '#3a3a3a')
    ramp.addColorStop(1, '#e6e6e6')
    sctx.fillStyle = ramp
    sctx.fillRect(-BOX.size / 2, -BOX.size / 2, BOX.size, BOX.size)
    sctx.restore()
    return source
  }

  const state = (t: number) => {
    const n = Math.floor(t / step)
    return { segment: n % segments.length, look: segments[n % segments.length] ?? first }
  }

  return {
    async render(t, o) {
      const s = state(t)
      const frame = card(t)
      // The source with no pass is the card itself; every other segment is one call to apply.
      const picture: Layer =
        s.look.id === 'source'
          ? { color: frame }
          : {
              color: looks.apply(frame, {
                look: s.look.look,
                ...s.look.params,
                grain: 0,
                vignette: 0,
                seed: o.frame,
              }),
              alpha: 'opaque',
            }
      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(passWords, cardWords, t, o.frame)
      house.notes(passNotes, t, o.frame)
      const name =
        s.look.id === 'source'
          ? 'OFF'
          : s.look.id === 'glitch'
            ? 'ROW GLITCH'
            : s.look.look.toUpperCase()
      house.hud(t, o.frame, `PASS ${name}   ONE WGSL DRAW`, 'CANVAS2D IN, TEXTURE OUT')
      return [picture, { color: canvas, name: 'house' }]
    },
    status(t) {
      const s = state(t)
      if (segments.length === 1) return s.look.id === 'source' ? 'pass off' : s.look.id
      return `${String(s.segment + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${s.look.id}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'looks', look: s.look.id }
    },
  }
}

export default lookScreenPasses
