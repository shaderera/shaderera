// font-instrument-serif: a type specimen that never holds still, in the house style. Two lines of
// Instrument Serif set large, white on black, every letter leaning between the plugin's roman and
// its italic on a wave that runs through the lines, a true in-between of the two outlines
// (resampled and morphed with text-glyph-outlines; a contour one face lacks grows from a point).
// Every 1.5 s each letter morphs into the next phrase's letter, and each line is refitted to the
// column. A red box tracks the most italic letter.

import { createMorphLines, type Ring, tracePixels } from '../../previews/src/glyph-morph.ts'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { loadFont } from '../../previews/src/type/outlines.ts'

const FACES = [
  'assets/fonts/InstrumentSerif-Regular.ttf',
  'assets/fonts/InstrumentSerif-Italic.ttf',
]
const STEP = 1.5
const MAX_SIZE = 330
const BASELINES = [400, 700]
const PHRASES: { lines: string[]; top: string; bottom: string; note: string }[] = [
  {
    lines: ['Editorial', 'display'],
    top: 'INSTRUMENT',
    bottom: 'SERIF',
    note: 'condensed, for titles and phrases',
  },
  {
    lines: ['Roman &', 'italic'],
    top: 'ROMAN',
    bottom: 'ITALIC',
    note: 'and every lean between the two',
  },
  {
    lines: ['Set it', 'large.'],
    top: 'DISPLAY',
    bottom: 'FACE',
    note: 'pair it with a sans for the small type',
  },
  {
    lines: ['Aa Gg Rr', '0123456789'],
    top: 'GLYPHS',
    bottom: 'OFL 1.1',
    note: 'an art-publication voice',
  },
]

const fontInstrumentSerif: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`font-instrument-serif has no state "${stateId}"`)
  const { width, height } = host.manifest
  const fonts = await Promise.all(FACES.map((f) => loadFont(host, f)))
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const words = (key: 'top' | 'bottom' | 'note'): Word[] =>
    PHRASES.map((p, i) => ({ from: i * STEP, to: (i + 1) * STEP, text: p[key] }))
  const TOPS = words('top')
  const BOTTOMS = words('bottom')
  const NOTES = words('note')

  /** A letter's lean: 0 roman, 1 italic. "Roman & italic" keeps each line near its own. */
  const face = (t: number, p: number, j: number, i: number) => {
    const wave = 0.5 + 0.5 * Math.sin((t / STEP) * Math.PI * 2 - i * 0.45 - j * 1.3)
    return p === 1 ? (j === 0 ? 0.25 * wave : 1 - 0.25 * wave) : wave
  }
  const lines = createMorphLines({
    fonts,
    phrases: PHRASES.map((p) => p.lines),
    n: 200,
    step: STEP,
    morph: 0.42,
    stagger: { line: 0.08, letter: 0.025 },
    // Each line as large as the column allows (its width taken in roman).
    place: (_p, j, widthEm) => ({
      x: L,
      baseline: BASELINES[j] ?? 0,
      size: Math.min(MAX_SIZE, (R - L - 10) / Math.max(0.1, widthEm)),
    }),
    face,
  })

  const bounds = (rings: Ring[]) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const r of rings)
      for (let i = 0; i < r.length; i += 2) {
        x0 = Math.min(x0, r[i] as number)
        x1 = Math.max(x1, r[i] as number)
        y0 = Math.min(y0, r[i + 1] as number)
        y1 = Math.max(y1, r[i + 1] as number)
      }
    return [x0, y0, x1, y1] as const
  }

  const state = (t: number) => {
    const frame = lines.at(t)
    let best = -1
    let most = -1
    for (const [k, l] of frame.letters.entries()) {
      if (l.rings.length === 0 || l.k < 1) continue
      const f = face(t, frame.phrase, l.line, l.index)
      if (f > most) {
        most = f
        best = k
      }
    }
    return { ...frame, best, most }
  }

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      theme.index()
      ctx.fillStyle = '#fff'
      for (const l of s.letters) {
        ctx.beginPath()
        tracePixels(ctx, l.rings)
        ctx.fill('nonzero')
      }
      const tracked = s.letters[s.best]
      if (tracked) {
        const [x0, y0, x1, y1] = bounds(tracked.rings)
        ctx.strokeStyle = RED
        ctx.lineWidth = 2
        ctx.strokeRect(x0 - 8, y0 - 8, x1 - x0 + 16, y1 - y0 + 16)
        ctx.fillStyle = RED
        ctx.fillRect(x0 - 9, y0 - 30, 106, 20)
        ctx.font = `14px "${FONT.mono}"`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = '#fff'
        ctx.fillText(`ITALIC ${s.most.toFixed(2)}`, x0 - 4, y0 - 15)
      }
      theme.words(TOPS, BOTTOMS, t, o.frame)
      theme.notes(NOTES, t, o.frame, R, 790)
      const mean =
        s.letters.reduce((a, l) => a + face(t, s.phrase, l.line, l.index), 0) /
        Math.max(1, s.letters.length)
      theme.hud(t, o.frame, `LEAN ${mean.toFixed(2)}`, 'REGULAR · ITALIC')
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${String(s.phrase + 1).padStart(2, '0')}/04  roman to italic`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'specimen', lines: PHRASES[s.phrase]?.lines ?? [], mostItalic: s.most }
    },
  }
}

export default fontInstrumentSerif
