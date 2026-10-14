// look-screen-passes: the plain grey test card (previews/src/card.ts) and the plugin's one pass
// over it. In the 'all' state the medium changes every 0.75 s with a hard cut: the card itself,
// then ascii, halftone, dither, heat, contours, pixels and inverse at their defaults (white ink on
// black). A state holds one medium; 'off' is the card with no pass. The medium is the big word
// top left, in the house style (house.ts) over the picture.

import type { Layer } from '@shaderera/core'
import { drawCard } from '../../previews/src/card.ts'
import { createHouse, type Word } from '../../previews/src/house.ts'
import { createLooks, type LookParams } from '../../previews/src/looks/looks.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

/** A medium, or the card itself (no params). */
type Segment = { id: string; word: string; note: string; params?: LookParams }

/** The media in order, an eighth of the loop each; the first follows the last. */
const SEGMENTS: Segment[] = [
  { id: 'source', word: 'SOURCE', note: 'the card, before any pass' },
  {
    id: 'ascii',
    word: 'ASCII',
    note: 'a glyph a cell, by its brightness',
    params: { look: 'ascii' },
  },
  {
    id: 'halftone',
    word: 'HALFTONE',
    note: 'dots with the area of the light under them',
    params: { look: 'halftone', cell: 18 },
  },
  {
    id: 'dither',
    word: 'DITHER',
    note: 'an ordered threshold, one bit deep',
    params: { look: 'dither', cell: 2 },
  },
  { id: 'heat', word: 'HEAT', note: 'brightness as a thermal palette', params: { look: 'heat' } },
  {
    id: 'contours',
    word: 'CONTOURS',
    note: 'lines where the light crosses a step',
    params: { look: 'contours', line: 2 },
  },
  {
    id: 'pixels',
    word: 'PIXELS',
    note: 'blocks of 27 px, each its mean',
    params: { look: 'pixels', cell: 27 },
  },
  { id: 'inverse', word: 'INVERSE', note: 'every value turned over', params: { look: 'inverse' } },
]

const lookScreenPasses: OpenPreview = async (host, stateId) => {
  // 'all' cycles through every medium; a state holds one ('off' is the card with no pass).
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

  const state = (t: number) => {
    const n = Math.floor(t / step)
    return { segment: n % segments.length, look: segments[n % segments.length] ?? first }
  }

  return {
    async render(t, o) {
      const s = state(t)
      drawCard(sctx, t, duration)
      // The source with no pass is the card itself; every other segment is one call to apply.
      const picture: Layer = s.look.params
        ? { color: looks.apply(source, s.look.params), alpha: 'opaque' }
        : { color: source }
      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(passWords, cardWords, t, o.frame)
      house.notes(passNotes, t, o.frame)
      const name = s.look.params ? s.look.id.toUpperCase() : 'OFF'
      house.hud(t, o.frame, `PASS ${name}   ONE WGSL DRAW`, 'CANVAS2D IN, TEXTURE OUT')
      return [picture, { color: canvas, name: 'house' }]
    },
    status(t) {
      const s = state(t)
      if (segments.length === 1) return s.look.params ? s.look.id : 'pass off'
      return `${String(s.segment + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${s.look.id}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'looks', look: s.look.id }
    },
  }
}

export default lookScreenPasses
