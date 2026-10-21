// look-film-grain: the plain grey test card (previews/src/card.ts) and the plugin's one call over
// it, strong and large enough to survive the preview's compression. In the 'all' state the setting
// changes every 1.5 s with a hard cut: fine grain, coarse grain, colour grain, then grain that
// holds (a constant seed) while the card turns under it; a state holds one. The setting is the big
// word top left.

import { CARD, drawCard } from '../../previews/src/card.ts'
import { createHouse, type Word } from '../../previews/src/house.ts'
import { createGrain, type GrainParams } from '../../previews/src/looks/grain.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'

type Segment = { id: string; word: string; note: string; params: GrainParams; holds?: boolean }

/** The settings in order, a quarter of the loop each; the first follows the last. */
const SEGMENTS: Segment[] = [
  {
    id: 'fine',
    word: 'FINE',
    note: 'grains of 2 px, new every frame',
    params: { amount: 0.1, size: 2 },
  },
  {
    id: 'coarse',
    word: 'COARSE',
    note: 'grains of 4 px, as strong',
    params: { amount: 0.1, size: 4 },
  },
  {
    id: 'colour',
    word: 'COLOUR',
    note: 'each channel its own grain',
    params: { amount: 0.1, size: 2, color: 1 },
  },
  {
    id: 'held',
    word: 'HELD',
    note: 'one seed: the grain holds still',
    params: { amount: 0.1, size: 2.5 },
    holds: true,
  },
]

const lookFilmGrain: OpenPreview = async (host, stateId) => {
  const segments = stateId === 'all' ? SEGMENTS : SEGMENTS.filter((s) => s.id === stateId)
  if (segments.length === 0) throw new Error(`look-film-grain has no state "${stateId}"`)
  if (!host.gpu) throw new Error('The look-film-grain preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const step = duration / segments.length
  const grain = createGrain(host, { width, height })
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

  return {
    async render(t, o) {
      const { segment } = segmentAt(t)
      drawCard(sctx, t, duration)
      const seed = segment.holds ? 7 : o.frame
      const color = grain.apply(source, { ...segment.params, seed })
      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(words, card, t, o.frame)
      house.notes(notes, t, o.frame)
      house.hud(
        t,
        o.frame,
        `σ ${segment.params.amount}   SIZE ${segment.params.size} PX   CARD ${CARD.size} PX`,
        'GAUSSIAN, BY TONE',
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
      return { id: 'grain', setting: segmentAt(t).segment.id }
    },
  }
}

export default lookFilmGrain
