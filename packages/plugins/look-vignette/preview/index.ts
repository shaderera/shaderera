// look-vignette: the plain grey test card (previews/src/card.ts) on a mid-grey ground and the
// plugin's one call over it. In the 'all' state the setting changes every 1.2 s with a hard cut: a
// soft round falloff, a hard late one, a centre that circles the frame, towards white, and a
// spotlight (an ellipse of a given size) that circles it; a state holds one. On this square frame
// the frame-shaped ellipse is the same circle, so it is not shown.
// The setting is the big word top left; a red cross marks the vignette's centre.

import { CARD, drawCard } from '../../previews/src/card.ts'
import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import { createVignette, type VignetteParams } from '../../previews/src/looks/vignette.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'

type Segment = { id: string; word: string; note: string; params: VignetteParams; orbit?: boolean }

/** The settings in order, a fifth of the loop each; the first follows the last. */
const SEGMENTS: Segment[] = [
  {
    id: 'round',
    word: 'ROUND',
    note: 'the corners towards black',
    params: { amount: 0.85, start: 0.25 },
  },
  {
    id: 'hard',
    word: 'HARD',
    note: 'a late start, all the way to black',
    params: { amount: 1, start: 0.6 },
  },
  {
    id: 'centre',
    word: 'CENTRE',
    note: 'from any centre',
    params: { amount: 0.9, start: 0.15 },
    orbit: true,
  },
  {
    id: 'white',
    word: 'WHITE',
    note: 'towards any colour, here white',
    params: { amount: 0.8, start: 0.25, colour: [1, 1, 1] },
  },
  {
    id: 'spotlight',
    word: 'SPOTLIGHT',
    note: 'an ellipse of a given size',
    params: { amount: 0.7, start: 0.55, size: [220, 150] },
    orbit: true,
  },
]

const lookVignette: OpenPreview = async (host, stateId) => {
  const segments = stateId === 'all' ? SEGMENTS : SEGMENTS.filter((s) => s.id === stateId)
  if (segments.length === 0) throw new Error(`look-vignette has no state "${stateId}"`)
  if (!host.gpu) throw new Error('The look-vignette preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const step = duration / segments.length
  const vignette = createVignette(host, { width, height })
  const source = host.io.canvas(width, height)
  const sctx = source.getContext('2d') as OffscreenCanvasRenderingContext2D
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const words: Word[] = segments.map((s, i) => ({
    from: i * step,
    to: (i + 1) * step,
    text: s.word,
  }))
  const notes: Word[] = segments.map((s, i) => ({ ...(words[i] as Word), text: s.note }))
  const card: Word[] = [{ from: 0, to: duration, text: 'TEST CARD' }]
  const segmentAt = (t: number) => {
    const n = Math.floor(t / step) % segments.length
    return { n, segment: segments[n] as Segment }
  }
  /** The centre at t: the frame's, or circling it, five times a loop (once in its fifth). */
  const centreAt = (t: number, orbit?: boolean): [number, number] => {
    if (!orbit) return [width / 2, CARD.y + CARD.size / 2]
    const a = (t / duration) * Math.PI * 2 * 5
    return [width / 2 + 260 * Math.cos(a), CARD.y + CARD.size / 2 + 220 * Math.sin(a)]
  }

  return {
    async render(t, o) {
      const { segment } = segmentAt(t)
      // A mid-grey ground, so the falloff shows out to the frame's edges.
      drawCard(sctx, t, duration, '#8a8a8a')
      const centre = centreAt(t, segment.orbit)
      const color = vignette.apply(source, { ...segment.params, centre })
      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(words, card, t, o.frame)
      house.notes(notes, t, o.frame)
      ctx.strokeStyle = RED
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(centre[0] - 14, centre[1])
      ctx.lineTo(centre[0] + 14, centre[1])
      ctx.moveTo(centre[0], centre[1] - 14)
      ctx.lineTo(centre[0], centre[1] + 14)
      ctx.stroke()
      house.hud(
        t,
        o.frame,
        `AMOUNT ${segment.params.amount}   START ${segment.params.start}`,
        'IN LINEAR LIGHT',
      )
      return [
        { color, alpha: 'opaque' },
        { color: canvas, name: 'house' },
      ]
    },
    status(t) {
      const { n, segment } = segmentAt(t)
      if (segments.length === 1) return segment.id
      return `${String(n + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${segment.id}`
    },
    inspect(t) {
      const { segment } = segmentAt(t)
      return { id: 'vignette', setting: segment.id, centre: centreAt(t, segment.orbit) }
    },
  }
}

export default lookVignette
