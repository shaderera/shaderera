// font-ibm-plex-mono: a type specimen that never holds still, in the house style. The frame is a
// monospace grid of characters over a flowing noise field: dim Light punctuation where the field
// is low, and inside one huge glyph the glyph set itself, scrambling, white, in bands of Light,
// Regular and SemiBold that sweep across it. The huge glyph morphs into the next every 0.75 s
// (A g & 0 { @ R #) and breathes from Light to SemiBold and back, a true in-between of the
// plugin's three weights (their outlines resampled and morphed with text-glyph-outlines). Its
// outline is drawn over the grid, and a red box tracks it.

import {
  atFace,
  type Family,
  familyOf,
  morph,
  pairingOf,
  type Ring,
  toPixels,
  tracePixels,
} from '../../previews/src/glyph-morph.ts'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { loadFont } from '../../previews/src/type/outlines.ts'

const FACES = [
  'assets/fonts/IBMPlexMono-Light.ttf',
  'assets/fonts/IBMPlexMono-Regular.ttf',
  'assets/fonts/IBMPlexMono-SemiBold.ttf',
]
const FAMILIES = [FONT.monoLight, FONT.mono, FONT.monoBold]
const GLYPHS = ['A', 'g', '&', '0', '{', '@', 'R', '#']
const BEAT = 0.75
const MORPH = 0.3
/** The grid: 20 px Plex Mono, a cell 0.6 em wide. */
const CELL_SIZE = 20
const CW = 12
const CH = 24
const TOP = 150
const ROWS = 26
const COLS = Math.floor((R - L) / CW)
/** The huge glyph: its em in px, and where its pen and baseline are. */
const EM = 640
const BASELINE = 640
const RAMP = ' .·:-=+*%'
const SET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}[]<>/#%&@$?!'
const WORDS: [string, string, string][] = [
  ['IBM PLEX', 'MONO', 'Light, Regular and SemiBold'],
  ['LIGHT', 'SEMIBOLD', 'and every weight between'],
  ['ASCII', 'LOOKS', 'every glyph 0.6 em wide'],
  ['CODE', 'AND DATA', '0O and 1lI, never confused'],
]

const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
const lattice = (x: number, y: number) =>
  hash((x & 1023) * 7919 + (y & 1023) * 104729 + 5) / 4294967296
const noise = (x: number, y: number) => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = lattice(xi, yi)
  const b = lattice(xi + 1, yi)
  const c = lattice(xi, yi + 1)
  const d = lattice(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
const ease = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
}

const fontIbmPlexMono: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`font-ibm-plex-mono has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const fonts = await Promise.all(FACES.map((f) => loadFont(host, f)))
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const mask = host.io.canvas(COLS, ROWS)
  const mctx = mask.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const step = duration / WORDS.length
  const words = (k: 0 | 1 | 2): Word[] =>
    WORDS.map((w, i) => ({ from: i * step, to: (i + 1) * step, text: w[k] }))
  const TOPS = words(0)
  const BOTTOMS = words(1)
  const NOTES = words(2)
  const families: Family[] = GLYPHS.map((g) => familyOf(fonts, g, 280))

  /** 0 Light, 1 Regular, 2 SemiBold: from thin to bold and back every 1.5 s. */
  const weight = (t: number) => 1 - Math.cos((t / 1.5) * Math.PI * 2)
  const state = (t: number) => {
    const n = Math.floor(t / BEAT)
    const since = t - n * BEAT
    const i = ((n % GLYPHS.length) + GLYPHS.length) % GLYPHS.length
    const prev = (i + GLYPHS.length - 1) % GLYPHS.length
    const w = Math.min(2, Math.max(0, weight(t)))
    const k = ease(since / MORPH)
    const famA = families[prev] as Family
    const famB = families[i] as Family
    const a = atFace(famA, w)
    const b = atFace(famB, w)
    const penA = width / 2 - (a.advance * EM) / 2
    const penB = width / 2 - (b.advance * EM) / 2
    const ra = toPixels(a.rings, penA, BASELINE, EM)
    const rb = toPixels(b.rings, penB, BASELINE, EM)
    const rings: Ring[] =
      k >= 1 ? rb : morph(ra, rb, pairingOf(`${GLYPHS[prev]}|${GLYPHS[i]}`, famA, famB), k)
    return { n, i, w, k, rings, glyph: GLYPHS[i] ?? '' }
  }
  const cssWeight = (w: number) => Math.round(w <= 1 ? 300 + 100 * w : 400 + 200 * (w - 1))

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      theme.index()

      // The glyph's coverage of every cell.
      mctx.setTransform(1, 0, 0, 1, 0, 0)
      mctx.clearRect(0, 0, COLS, ROWS)
      mctx.setTransform(1 / CW, 0, 0, 1 / CH, -L / CW, -TOP / CH)
      mctx.fillStyle = '#fff'
      mctx.beginPath()
      tracePixels(mctx, s.rings)
      mctx.fill('nonzero')
      const cover = new Uint8Array(mctx.getImageData(0, 0, COLS, ROWS).data)

      // The grid, a face at a time.
      const loop = (t / duration) * Math.PI * 2
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      for (let f = 0; f < 3; f++) {
        ctx.font = `${CELL_SIZE}px "${FAMILIES[f]}"`
        for (let r = 0; r < ROWS; r++)
          for (let c = 0; c < COLS; c++) {
            const inside = (cover[(r * COLS + c) * 4 + 3] ?? 0) / 255
            const x = L + c * CW
            const y = TOP + (r + 1) * CH - 6
            if (inside > 0.25) {
              // The glyph set, scrambling, in bands of weight sweeping across the glyph.
              const band = (((c * 0.035 + r * 0.06 - t / 0.75) % 1) + 1) % 1
              const face = band < 0.34 ? 0 : band < 0.67 ? 1 : 2
              if (face !== f) continue
              const ch =
                SET[hash(c * 131 + r * 977 + Math.floor(o.frame / 2) * 7) % SET.length] ?? '#'
              ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * inside})`
              ctx.fillText(ch, x, y)
            } else if (f === 0) {
              // The field: a flow that loops with the clip.
              const v =
                0.65 * noise(c * 0.09 + 2.5 * Math.cos(loop), r * 0.16 + 2.5 * Math.sin(loop)) +
                0.35 * noise(c * 0.23 - 4 * Math.sin(loop), r * 0.4 + 4 * Math.cos(loop))
              const lift = Math.max(0, v - 0.22) / 0.78
              const ch =
                RAMP[Math.min(RAMP.length - 1, Math.floor(lift * lift * RAMP.length * 1.2))] ?? ' '
              if (ch === ' ') continue
              ctx.fillStyle = `rgba(220,220,220,${0.14 + 0.6 * lift})`
              ctx.fillText(ch, x, y)
            }
          }
      }

      // The huge glyph's outline over the grid, and the red box that tracks it.
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      tracePixels(ctx, s.rings)
      ctx.stroke()
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const ring of s.rings)
        for (let i = 0; i < ring.length; i += 2) {
          x0 = Math.min(x0, ring[i] as number)
          x1 = Math.max(x1, ring[i] as number)
          y0 = Math.min(y0, ring[i + 1] as number)
          y1 = Math.max(y1, ring[i + 1] as number)
        }
      if (x1 > x0) {
        ctx.strokeStyle = RED
        ctx.lineWidth = 2
        ctx.strokeRect(x0 - 12, y0 - 12, x1 - x0 + 24, y1 - y0 + 24)
        ctx.fillStyle = RED
        ctx.fillRect(x0 - 13, y0 - 34, 150, 20)
        ctx.font = `14px "${FONT.mono}"`
        ctx.fillStyle = '#fff'
        const code = `U+${(s.glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
        ctx.fillText(`${code}  W ${cssWeight(s.w)}`, x0 - 8, y0 - 19)
      }
      theme.words(TOPS, BOTTOMS, t, o.frame)
      theme.notes(NOTES, t, o.frame, R, 790)
      theme.hud(
        t,
        o.frame,
        `WEIGHT ${cssWeight(s.w)}   GLYPH ${s.glyph}`,
        `COLS ${COLS}   ROWS ${ROWS}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${s.glyph}  ${cssWeight(s.w)}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'specimen', glyph: s.glyph, weight: cssWeight(s.w), morph: s.k }
    },
  }
}

export default fontIbmPlexMono
