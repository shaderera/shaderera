// font-ibm-plex-sans: a type specimen that never holds still, in the house style. Three lines of
// Plex Sans, white on black, every letter at its own weight on a wave that runs through the lines,
// a true in-between of the plugin's Light, Regular and Medium (their outlines resampled and morphed
// with text-glyph-outlines). Every 1.5 s each letter morphs into the next phrase's letter: what
// the face is for, its glyphs, its three weights by name, its name. A red box tracks the
// heaviest letter and reads its weight.

import { createMorphLines, type Ring, tracePixels } from '../../previews/src/glyph-morph.ts'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { loadFont } from '../../previews/src/type/outlines.ts'

const FACES = [
  'assets/fonts/IBMPlexSans-Light.ttf',
  'assets/fonts/IBMPlexSans-Regular.ttf',
  'assets/fonts/IBMPlexSans-Medium.ttf',
]
const WEIGHTS = [300, 400, 500]
const STEP = 1.5
const SIZE = 205
const BASELINES = [305, 508, 711]
const PHRASES: { lines: string[]; top: string; bottom: string; note: string }[] = [
  {
    lines: ['Names,', 'dates,', 'labels'],
    top: 'IBM PLEX',
    bottom: 'SANS',
    note: 'for names, dates, labels and captions',
  },
  {
    lines: ['Aa Bb Cc', 'Gg Rr Qq', '0123456'],
    top: 'LATIN',
    bottom: 'GLYPHS',
    note: 'a restrained grotesque',
  },
  {
    lines: ['Light', 'Regular', 'Medium'],
    top: 'LIGHT',
    bottom: 'MEDIUM',
    note: '300, 400 and 500, and every weight between',
  },
  {
    lines: ['IBM Plex', 'Sans', '&?!@%'],
    top: 'THREE',
    bottom: 'WEIGHTS',
    note: 'OFL 1.1, from IBM',
  },
]

const fontIbmPlexSans: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`font-ibm-plex-sans has no state "${stateId}"`)
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

  /** A letter's face: 0 Light, 1 Regular, 2 Medium. The named phrase keeps each line near its own. */
  const face = (t: number, p: number, j: number, i: number) =>
    p === 2
      ? Math.min(2, Math.max(0, j + 0.3 * Math.sin((t / 0.75) * Math.PI * 2 + i * 0.7)))
      : 1 + Math.sin((t / STEP) * Math.PI * 2 - i * 0.55 - j * 0.9)
  const lines = createMorphLines({
    fonts,
    phrases: PHRASES.map((p) => p.lines),
    n: 150,
    step: STEP,
    morph: 0.42,
    stagger: { line: 0.07, letter: 0.03 },
    place: (_p, j) => ({ x: L, baseline: BASELINES[j] ?? 0, size: SIZE }),
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
    // The heaviest letter on screen that has ink, for the tracking box.
    let best = -1
    let heaviest = -1
    for (const [k, l] of frame.letters.entries()) {
      if (l.rings.length === 0 || l.k < 1) continue
      const w = face(t, frame.phrase, l.line, l.index)
      if (w > heaviest) {
        heaviest = w
        best = k
      }
    }
    const mean =
      frame.letters.reduce((s, l) => s + face(t, frame.phrase, l.line, l.index), 0) /
      Math.max(1, frame.letters.length)
    return { ...frame, best, heaviest, mean }
  }
  const cssWeight = (w: number) => Math.round(300 + 100 * w)

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
        ctx.fillRect(x0 - 9, y0 - 30, 64, 20)
        ctx.font = `14px "${FONT.mono}"`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = '#fff'
        ctx.fillText(`W ${cssWeight(s.heaviest)}`, x0 - 4, y0 - 15)
      }
      theme.words(TOPS, BOTTOMS, t, o.frame)
      theme.notes(NOTES, t, o.frame, R, 790)
      theme.hud(t, o.frame, `MEAN WEIGHT ${cssWeight(s.mean)}`, `${WEIGHTS.join(' · ')}`)
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${String(s.phrase + 1).padStart(2, '0')}/04  ${cssWeight(s.mean)}`
    },
    inspect(t) {
      const s = state(t)
      return {
        id: 'specimen',
        lines: PHRASES[s.phrase]?.lines ?? [],
        meanWeight: cssWeight(s.mean),
        heaviest: cssWeight(s.heaviest),
      }
    },
  }
}

export default fontIbmPlexSans
