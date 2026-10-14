// look-row-glitch: the plain grey test card (previews/src/card.ts) and the plugin's one call over
// it. In the 'all' state the setting changes every 1.5 s with a hard cut: bands thrown, a pixel
// sort along rows, one down columns, then both at once; a state holds one. The seed changes every
// 4 frames, so the thrown bands jump on their own. The setting is the big word top left.

import { CARD, drawCard } from '../../previews/src/card.ts'
import { createHouse, type Word } from '../../previews/src/house.ts'
import { createRowGlitch, type RowGlitchParams } from '../../previews/src/looks/row-glitch.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'

type Segment = { id: string; word: string; note: string; params: RowGlitchParams }

/** The settings in order, a quarter of the loop each; the first follows the last. */
const SEGMENTS: Segment[] = [
  {
    id: 'shift',
    word: 'THROWN',
    note: 'bands of rows thrown sideways',
    params: { rows: 0.4, shift: 0.18, sort: 0 },
  },
  {
    id: 'sort',
    word: 'SORTED',
    note: 'runs of light sorted dark to bright',
    params: { rows: 1, shift: 0, sort: 1, range: [0.12, 1] },
  },
  {
    id: 'columns',
    word: 'COLUMNS',
    note: 'the same sort, down the columns',
    params: { rows: 1, shift: 0, sort: 1, range: [0.12, 1], axis: 'columns', order: 'descending' },
  },
  {
    id: 'both',
    word: 'BOTH',
    note: 'some bands thrown, some of those sorted',
    params: { rows: 0.45, shift: 0.15, sort: 0.6 },
  },
]

const lookRowGlitch: OpenPreview = async (host, stateId) => {
  const segments = stateId === 'all' ? SEGMENTS : SEGMENTS.filter((s) => s.id === stateId)
  if (segments.length === 0) throw new Error(`look-row-glitch has no state "${stateId}"`)
  if (!host.gpu) throw new Error('The look-row-glitch preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const step = duration / segments.length
  const glitch = createRowGlitch(host, { width, height })
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
      const color = glitch.apply(source, { ...segment.params, seed: Math.floor(o.frame / 4) })
      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(words, card, t, o.frame)
      house.notes(notes, t, o.frame)
      house.hud(t, o.frame, `CARD ${CARD.size} PX   ONE COMPUTE PASS`, 'PIXELS MOVE, NONE CHANGE')
      return [
        { color, alpha: 'straight' },
        { color: canvas, name: 'house' },
      ]
    },
    status(t) {
      const { n, segment } = segmentAt(t)
      if (segments.length === 1) return segment.id
      return `${String(n + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${segment.id}`
    },
    inspect(t) {
      return { id: 'row-glitch', setting: segmentAt(t).segment.id }
    },
  }
}

export default lookRowGlitch
