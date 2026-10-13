// text-glyph-morph: the plugin's two calls, nothing else, in Plex Sans Medium (from
// font-ibm-plex-sans). 'words': two lines that morph letter by letter (morphLetters) into the next
// pair of words every 1.5 s, the delays per line and letter laid out so some letter is always on
// its way. 'glyph': one huge glyph that morphs (morphOf) into the next every second, drawn as the
// rings the plugin returns: the outline, every resampled point, and its bounds (boundsOf) in red.
// Both cycles end where they began, so the loop has no seam.

import { createHouse, L, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import {
  boundsOf,
  lettersOf,
  type Morph,
  morphLetters,
  morphOf,
  shapeOf,
  tracePath,
} from '../../previews/src/type/glyph-morph.ts'
import { loadFont } from '../../previews/src/type/outlines.ts'

const FONT_FILE = 'assets/fonts/IBMPlexSans-Medium.ttf'
const WORDS = [
  ['Shape', 'Morph'],
  ['Glyph', 'Outline'],
  ['Every', 'letter'],
  ['Holes', 'close'],
]
const GLYPHS = ['A', 'g', '&', '8', 'R', '@']
const POINTS = 160
/** Words: the size and baselines of the two lines, and the delays per line and per letter. */
const SIZE = 200
const BASELINES = [410, 690]
const DELAY = { line: 0.1, letter: 0.07 }
/** Glyph: px per em and the baseline. */
const EM = 560
const BASELINE = 650

const ease = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return 0.5 - 0.5 * Math.cos(Math.PI * c)
}

const textGlyphMorph: OpenPreview = async (host, state) => {
  if (state !== 'words' && state !== 'glyph')
    throw new Error(`text-glyph-morph has no state "${state}"`)
  const { width, height, duration } = host.manifest
  const font = await loadFont(host, FONT_FILE)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const whole = (text: string): Word[] => [{ from: 0, to: duration, text }]
  const TOP = whole(state === 'words' ? 'MORPH' : 'GLYPH')
  const BOTTOM = whole(state === 'words' ? 'LETTERS' : 'MORPH')

  // Words: for each step, line j's morph from the previous pair into this one.
  const wordStep = duration / WORDS.length
  const longest = Math.max(...WORDS.flat().map((w) => w.length))
  const window = wordStep - DELAY.line - (longest - 1) * DELAY.letter
  const lines = WORDS.map((pair, s) => {
    const prev = WORDS[(s + WORDS.length - 1) % WORDS.length] as string[]
    return pair.map((w, j) => morphLetters(lettersOf(font, prev[j] ?? ''), lettersOf(font, w)))
  })

  // Glyph: each glyph's morph into the next, the whole step long.
  const glyphStep = duration / GLYPHS.length
  const shapes = GLYPHS.map((g) => shapeOf(font, g, { points: POINTS }))
  const glyphs: Morph[] = shapes.map((a, i) => morphOf(a, shapes[(i + 1) % shapes.length] ?? a))

  const words = (t: number) => {
    const s = Math.floor(t / wordStep) % WORDS.length
    const since = t - s * wordStep
    ctx.fillStyle = '#fff'
    let moving = 0
    for (const [j, letters] of (lines[s] ?? []).entries()) {
      ctx.beginPath()
      for (const [i, m] of letters.entries()) {
        const k = ease((since - j * DELAY.line - i * DELAY.letter) / window)
        if (k > 0 && k < 1) moving++
        tracePath(ctx, m.at(k).rings, { x: L, y: BASELINES[j] ?? 0, size: SIZE })
      }
      ctx.fill('nonzero')
    }
    return { pair: WORDS[s] ?? [], moving }
  }

  const glyph = (t: number) => {
    const s = Math.floor(t / glyphStep) % GLYPHS.length
    const k = ease((t - s * glyphStep) / glyphStep)
    const shape = (glyphs[s] as Morph).at(k)
    const x = width / 2 - (shape.width * EM) / 2
    ctx.beginPath()
    tracePath(ctx, shape.rings, { x, y: BASELINE, size: EM })
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fill('nonzero')
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = '#fff'
    for (const r of shape.rings)
      for (let i = 0; i < r.length; i += 2)
        ctx.fillRect(x + (r[i] as number) * EM - 2, BASELINE - (r[i + 1] as number) * EM - 2, 4, 4)
    const b = boundsOf(shape.rings)
    if (b) {
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      ctx.strokeRect(
        x + b[0] * EM - 12,
        BASELINE - b[3] * EM - 12,
        (b[2] - b[0]) * EM + 24,
        (b[3] - b[1]) * EM + 24,
      )
    }
    return {
      from: GLYPHS[s] ?? '',
      to: GLYPHS[(s + 1) % GLYPHS.length] ?? '',
      k,
      rings: shape.rings.length,
    }
  }

  return {
    async render(t, o) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      if (state === 'words') {
        const w = words(t)
        house.words(TOP, BOTTOM, t, o.frame)
        house.note('morphLetters: letter i into letter i')
        house.hud(
          t,
          o.frame,
          `${POINTS} POINTS A RING   ${w.moving} LETTERS MOVING`,
          w.pair.join(' / ').toUpperCase(),
        )
      } else {
        const g = glyph(t)
        house.words(TOP, BOTTOM, t, o.frame)
        house.note('morphOf: outers to outers, holes to holes, the rest from points')
        house.hud(
          t,
          o.frame,
          `${g.from} TO ${g.to}   K ${g.k.toFixed(2)}`,
          `${g.rings} RINGS × ${POINTS} POINTS`,
        )
      }
      return [{ color: canvas }]
    },
    status(t) {
      if (state === 'words') {
        const s = Math.floor(t / wordStep) % WORDS.length
        return (WORDS[s] ?? []).join(' ')
      }
      const s = Math.floor(t / glyphStep) % GLYPHS.length
      return `${GLYPHS[s]} → ${GLYPHS[(s + 1) % GLYPHS.length]}`
    },
    inspect(t) {
      return { id: 'morph', state, t, font: FONT.sansMedium }
    },
  }
}

export default textGlyphMorph
