// look-blur: the plain grey test card (previews/src/card.ts), its wedge along the foot, and the
// plugin's one call over it: the whole card blurred except a sharp window that slides across and back once a loop. In the 'all'
// state the kind changes every 1.5 s with a hard cut: gaussian, bokeh, directional, radial; a
// state holds one. The kind is the big word top left, in the house style (house.ts); red corner
// marks show where the window is.

import { CARD, drawCard } from '../../previews/src/card.ts'
import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import { type BlurKind, type BlurParams, createBlur } from '../../previews/src/looks/blur.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'

type Segment = { kind: BlurKind; note: string; params: BlurParams }

/** The kinds in order, a quarter of the loop each; the first follows the last. */
const SEGMENTS: Segment[] = [
  { kind: 'gaussian', note: 'soft; sigma half the radius', params: { radius: 64 } },
  {
    kind: 'bokeh',
    note: 'a lens: each light opens into a disc',
    params: { radius: 30, blades: 6, rotation: 0.26, highlights: 8 },
  },
  { kind: 'directional', note: 'a smear along one angle', params: { radius: 48, angle: 0.35 } },
  { kind: 'radial', note: 'a zoom out from the centre', params: { radius: 70 } },
]

/** The sharp window: its size, and how far its centre swings either side of the middle. */
const WINDOW = { w: 190, h: 430, swing: 250 }

const lookBlur: OpenPreview = async (host, stateId) => {
  const segments = stateId === 'all' ? SEGMENTS : SEGMENTS.filter((s) => s.kind === stateId)
  if (segments.length === 0) throw new Error(`look-blur has no state "${stateId}"`)
  if (!host.gpu) throw new Error('The look-blur preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const step = duration / segments.length
  const blur = createBlur(host, { width, height })
  const source = host.io.canvas(width, height)
  const sctx = source.getContext('2d') as OffscreenCanvasRenderingContext2D
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const kindWords: Word[] = segments.map((s, i) => ({
    from: i * step,
    to: (i + 1) * step,
    text: s.kind.toUpperCase(),
  }))
  const kindNotes: Word[] = segments.map((s, i) => ({ ...(kindWords[i] as Word), text: s.note }))
  const windowWords: Word[] = [{ from: 0, to: duration, text: 'SHARP WINDOW' }]

  /** The window at t: across and back once a loop, so the last frame meets the first. */
  const windowAt = (t: number) => {
    const cx = width / 2 + WINDOW.swing * Math.sin((t / duration) * Math.PI * 2)
    return { x: cx - WINDOW.w / 2, y: CARD.y + 110, width: WINDOW.w, height: WINDOW.h }
  }

  /** Red marks at the window's corners. */
  const marks = (b: { x: number; y: number; width: number; height: number }) => {
    ctx.strokeStyle = RED
    ctx.lineWidth = 3
    const k = 22
    for (const [x, y, dx, dy] of [
      [b.x, b.y, 1, 1],
      [b.x + b.width, b.y, -1, 1],
      [b.x, b.y + b.height, 1, -1],
      [b.x + b.width, b.y + b.height, -1, -1],
    ] as const) {
      ctx.beginPath()
      ctx.moveTo(x + dx * k, y)
      ctx.lineTo(x, y)
      ctx.lineTo(x, y + dy * k)
      ctx.stroke()
    }
  }

  const segmentAt = (t: number) => {
    const n = Math.floor(t / step) % segments.length
    return { n, segment: segments[n] as Segment }
  }

  return {
    async render(t, o) {
      const { segment } = segmentAt(t)
      const win = windowAt(t)
      // The wedge along the foot, up to light grey, not white: the small lights are the only
      // highlights on the card.
      drawCard(sctx, t, duration, { wedge: 'bottom', white: 215 })
      const color = blur.apply(source, {
        kind: segment.kind,
        ...segment.params,
        shapes: [{ ...win, amount: 0, round: 6 }],
      })
      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(kindWords, windowWords, t, o.frame)
      house.notes(kindNotes, t, o.frame)
      marks(win)
      house.hud(
        t,
        o.frame,
        `RADIUS ${segment.params.radius} PX   WINDOW ${WINDOW.w} × ${WINDOW.h}`,
        'CANVAS2D IN, TEXTURE OUT',
      )
      return [
        { color, alpha: 'premultiplied' },
        { color: canvas, name: 'house' },
      ]
    },
    status(t) {
      const { n, segment } = segmentAt(t)
      if (segments.length === 1) return segment.kind
      return `${String(n + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${segment.kind}`
    },
    inspect(t) {
      const { segment } = segmentAt(t)
      return { id: 'blur', kind: segment.kind, window: windowAt(t) }
    },
  }
}

export default lookBlur
