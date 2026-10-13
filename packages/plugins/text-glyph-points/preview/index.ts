// text-glyph-points: the point sets the plugin returns for four words, drawn as still dots, a hard
// cut between words every 1.5 s. Under each word, red ticks stand at its character marks (the
// left edge of every character, in text widths), with marks[6] of SHADERERA, where ERA begins,
// set taller. A playhead scans each word left to right, lighting the dots and the marks it has
// passed: presentation only, the points never move. The last word cuts back to the first.

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { type GlyphPoints, glyphPoints } from '../../previews/src/procedural/glyph-points.ts'

type Phrase = {
  text: string
  /** A mark to set taller (a character index). */
  mark?: number
  top: string
  bottom: string
  note: string
}
const PHRASES: Phrase[] = [
  { text: 'GLYPH', top: 'TEXT', bottom: 'TO POINTS', note: '8,192 points, the same every run' },
  { text: 'POINTS', top: 'FIXED', bottom: 'POINT SET', note: 'x, y in text widths, y up' },
  { text: 'SHADERERA', mark: 6, top: 'WORD', bottom: 'MARK', note: 'marks[6], where ERA begins' },
  { text: 'LETTERS', top: 'EVERY', bottom: 'LETTER', note: 'the left edge of every character' },
]
const COUNT = 1 << 13
const STEP = 1.5
/** The band the word may fill: clear of the corner words, with room for the marks under it. */
const TOP = 210
const BOTTOM = 560
const MID = (TOP + BOTTOM) / 2
const DOT = 2.4

type Set = {
  phrase: Phrase
  points: GlyphPoints
  xs: Float32Array
  ys: Float32Array
  /** The marks in screen x, the ink's left and right edges, and the word's bottom. */
  marks: number[]
  left: number
  right: number
  bottom: number
}

const textGlyphPoints: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`text-glyph-points has no state "${stateId}"`)
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`
  const words = (key: 'top' | 'bottom' | 'note'): Word[] =>
    PHRASES.map((p, i) => ({ from: i * STEP, to: (i + 1) * STEP, text: p[key] }))
  const TOPS = words('top')
  const BOTTOMS = words('bottom')
  const NOTES = words('note')

  // Each word's point set, as the README calls it, placed once: as wide as the column, unless
  // that is taller than the band.
  const sets: Set[] = PHRASES.map((phrase, k) => {
    const points = glyphPoints(host, {
      text: phrase.text,
      family: FONT.monoBold,
      count: COUNT,
      seed: k,
    })
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 1; i < points.points.length; i += 2) {
      const y = points.points[i] as number
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    const column = Math.min(R - L, (BOTTOM - TOP) / (y1 - y0))
    const xs = new Float32Array(COUNT)
    const ys = new Float32Array(COUNT)
    for (let i = 0; i < COUNT; i++) {
      xs[i] = width / 2 + (points.points[i * 2] as number) * column
      ys[i] = MID - ((points.points[i * 2 + 1] as number) - (y0 + y1) / 2) * column
    }
    return {
      phrase,
      points,
      xs,
      ys,
      marks: points.marks.map((m) => width / 2 + m * column),
      left: width / 2 - 0.5 * column,
      right: width / 2 + 0.5 * column,
      bottom: MID + ((y1 - y0) / 2) * column,
    }
  })

  const state = (t: number) => {
    const n = Math.floor(t / STEP)
    const index = ((n % sets.length) + sets.length) % sets.length
    const since = t - n * STEP
    const set = sets[index] as Set
    // The playhead crosses the word over the whole hold, a little past each edge.
    const head = set.left - 30 + (set.right - set.left + 60) * (since / STEP)
    return { index, since, set, head }
  }

  const dots = (set: Set, head: number, lit: boolean) => {
    ctx.fillStyle = lit ? '#fff' : '#5c5c5c'
    for (let i = 0; i < COUNT; i++) {
      const x = set.xs[i] as number
      if (x < head === lit) ctx.fillRect(x - DOT / 2, (set.ys[i] as number) - DOT / 2, DOT, DOT)
    }
  }

  return {
    async render(t, o) {
      const s = state(t)
      const set = s.set
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      dots(set, s.head, false)
      dots(set, s.head, true)

      // The playhead, with where it is in the plugin's units (text widths).
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.fillRect(Math.round(s.head), TOP - 40, 1, BOTTOM - TOP + 80)
      ctx.font = `14px ${mono}`
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      ctx.fillStyle = '#9a9a9a'
      const u = (s.head - width / 2) / (set.right - set.left)
      ctx.fillText(`x ${u >= 0 ? ' ' : ''}${u.toFixed(3)}`, Math.round(s.head) + 6, TOP - 28)

      // The marks: a red tick at each character's left edge, its index and value beside it.
      const base = set.bottom + 56
      for (const [c, m] of set.marks.entries()) {
        const tall = set.phrase.mark === c
        const passed = m <= s.head
        ctx.fillStyle = RED
        ctx.fillRect(Math.round(m), base - (tall ? 44 : 22), tall ? 3 : 2, tall ? 44 : 22)
        ctx.fillStyle = passed ? '#fff' : '#6a6a6a'
        ctx.fillText(
          `${c}  ${(set.points.marks[c] ?? 0).toFixed(3)}`,
          Math.max(L, Math.round(m) + 6),
          base - 4,
        )
      }

      house.words(TOPS, BOTTOMS, t, o.frame)
      house.notes(NOTES, t, o.frame)
      house.hud(
        t,
        o.frame,
        `POINTS ${COUNT.toLocaleString('en-US')}   ASPECT ${set.points.aspect.toFixed(3)}`,
        `SEED ${s.index}   MARKS ${set.marks.length}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${String(s.index + 1).padStart(2, '0')}/04  ${s.set.phrase.text}`
    },
    inspect(t) {
      const s = state(t)
      return {
        id: 'points',
        text: s.set.phrase.text,
        count: COUNT,
        aspect: s.set.points.aspect,
        marks: s.set.points.marks,
      }
    },
  }
}

export default textGlyphPoints
