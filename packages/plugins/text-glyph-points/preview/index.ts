// text-glyph-points: a quarter of a million particles that keep forming words, in the house style.
// Each word is the item's point set for its text (a fixed count, so particle i always has a
// place). Every 1.5 s the cloud flies from one word to the next along a smooth flow field, swept
// left to right, with a hard cut of the corner words. While a word holds, it comes apart on the
// item's character marks (ticked in red under it): SHADERERA splits at marks[6], where ERA
// begins, and LETTERS steps apart letter by letter. The particles are splatted in JavaScript with
// a short motion trail, a few tinted with the film's pastels; the fourth word flies back into the
// first, so the loop has no seam.

import { createHouse, iridescent, L, PICTURE, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { type GlyphPoints, glyphPoints } from '../../previews/src/procedural/glyph-points.ts'

type Phrase = {
  text: string
  /** Where the word splits in two while it holds (a character index), or each letter steps apart. */
  split?: number
  top: string
  bottom: string
  note: string
}
const PHRASES: Phrase[] = [
  { text: 'GLYPH', top: 'TEXT', bottom: 'TO POINTS', note: '262,144 points, the same every run' },
  {
    text: 'POINTS',
    top: 'FIXED',
    bottom: 'POINT SET',
    note: 'one hash per point, never Math.random',
  },
  { text: 'SHADERERA', split: 6, top: 'WORD', bottom: 'MARK', note: 'marks[6], where ERA begins' },
  { text: 'LETTERS', top: 'EVERY', bottom: 'LETTER', note: 'each letter on its own mark' },
]
const COUNT = 1 << 18
const STEP = 1.5
/** How long one particle's flight takes; the sweep spreads the starts over SWEEP more. */
const FLIGHT = 0.62
const SWEEP = 0.34
/** The band the word may fill: clear of the corner words. */
const TOP = 250
const BOTTOM = 640
const MID = 450
/** One particle in this many is tinted. */
const TINT_EVERY = 4
/** Trail samples behind each particle, in seconds. */
const TRAIL = [0.012, 0.026, 0.042]
/** How far apart the letters step while a word holds, per character from the middle. */
const STEP_APART = 26
const SPLIT_APART = 60

const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
const rnd = (v: number) => hash(v) / 4294967296

// Smooth value noise, for a flow field neighbouring particles share.
const lattice = (x: number, y: number) => rnd((x & 1023) * 7919 + (y & 1023) * 104729 + 17)
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

type Set = {
  phrase: Phrase
  points: GlyphPoints
  /** Every particle's screen position, and how far it moves (in steps) when the word comes apart. */
  xs: Float32Array
  ys: Float32Array
  offset: Float32Array
  /** How much the word narrows while it comes apart, so it keeps its width. */
  shrink: number
  /** The marks in screen x, the ink's right edge, and the word's bottom. */
  marks: number[]
  right: number
  bottom: number
}

const textGlyphPoints: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`text-glyph-points has no state "${stateId}"`)
  const { width, height } = host.manifest
  const pixels = new Uint8ClampedArray(width * height * 4)
  const white = new Float32Array(width * height)
  const tint = new Float32Array(width * height * 3)
  const under = host.io.canvas(width, height)
  const uctx = under.getContext('2d') as OffscreenCanvasRenderingContext2D
  const overlay = host.io.canvas(width, height)
  const ctx = overlay.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const behind = createHouse(host, uctx)
  const mono = `"${FONT.mono}"`
  const words = (key: 'top' | 'bottom' | 'note'): Word[] =>
    PHRASES.map((p, i) => ({ from: i * STEP, to: (i + 1) * STEP, text: p[key] }))
  const TOPS = words('top')
  const BOTTOMS = words('bottom')
  const NOTES = words('note')

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
    const n = points.marks.length
    const apart = phrase.split !== undefined ? SPLIT_APART : ((n - 1) / 2) * STEP_APART
    // As wide as the column (less what coming apart adds), unless that is taller than the band.
    const column = Math.min(R - L, (BOTTOM - TOP) / (y1 - y0))
    const xs = new Float32Array(COUNT)
    const ys = new Float32Array(COUNT)
    const offset = new Float32Array(COUNT)
    for (let i = 0; i < COUNT; i++) {
      const px = points.points[i * 2] as number
      xs[i] = width / 2 + px * column
      ys[i] = MID - ((points.points[i * 2 + 1] as number) - (y0 + y1) / 2) * column
      let c = 0
      while (c + 1 < n && (points.marks[c + 1] as number) <= px) c++
      offset[i] =
        phrase.split !== undefined
          ? (c >= phrase.split ? 1 : -1) * SPLIT_APART
          : (c - (n - 1) / 2) * STEP_APART
    }
    return {
      phrase,
      points,
      xs,
      ys,
      offset,
      shrink: (2 * apart) / column,
      marks: points.marks.map((m) => width / 2 + m * column),
      right: width / 2 + 0.5 * column,
      bottom: MID + ((y1 - y0) / 2) * column,
    }
  })
  const setAt = (k: number) => sets[((k % sets.length) + sets.length) % sets.length] as Set

  // Each particle's flight: where along the sweep it leaves, and how far the flow throws it.
  const delay = new Float32Array(COUNT)
  const throwAt = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    delay[i] = rnd(i * 5 + 1) * 0.12
    throwAt[i] = 0.55 + 0.9 * rnd(i * 5 + 2)
  }

  /** How far the holding word stands apart (0 together). */
  const spread = (since: number) => {
    const open = ease((since - FLIGHT - SWEEP + 0.05) / 0.28)
    const close = ease((since - (STEP - 0.12)) / 0.12)
    return open * (1 - close)
  }

  const state = (t: number) => {
    const n = Math.floor(t / STEP)
    const since = t - n * STEP
    return { n, since, index: ((n % sets.length) + sets.length) % sets.length }
  }

  // Particle i's position at time t, into out[0], out[1].
  const out = new Float32Array(2)
  const place = (i: number, t: number) => {
    const n = Math.floor(t / STEP)
    const since = t - n * STEP
    const to = setAt(n)
    const from = setAt(n - 1)
    const ax = from.xs[i] as number
    const ay = from.ys[i] as number
    const bx = to.xs[i] as number
    const by = to.ys[i] as number
    // Left to right across the word it leaves.
    const start = ((ax - L) / (R - L)) * SWEEP + (delay[i] as number)
    const e = ease((since - start) / FLIGHT)
    let x = ax + (bx - ax) * e
    let y = ay + (by - ay) * e
    if (e > 0 && e < 1) {
      const lift = Math.sin(Math.PI * e)
      const a = 6.2831853 * 2 * noise(ax * 0.006 + n * 3.1, ay * 0.006)
      const d = 230 * (throwAt[i] as number) * lift
      x += Math.cos(a) * d
      y += Math.sin(a) * d * 0.8
    }
    // Holding: the word comes apart on its marks, and its letters bob, each on its own phase.
    const s = spread(since)
    if (s > 0 && e >= 1) {
      const off = to.offset[i] as number
      x += (bx - width / 2) * -to.shrink * s + off * s
      y += Math.sin(off * 0.07 + since * 9) * 12 * s
    }
    out[0] = x
    out[1] = y
  }

  const splat = (i: number, x: number, y: number, w: number) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= PICTURE - 1) return
    const fx = x - x0
    const fy = y - y0
    const o = y0 * width + x0
    const ws = [w * (1 - fx) * (1 - fy), w * fx * (1 - fy), w * (1 - fx) * fy, w * fx * fy]
    const at = [o, o + 1, o + width, o + width + 1]
    if (i % TINT_EVERY === 0) {
      // A pastel that drifts across the frame, as in the film's iridescence.
      const [r, g, b] = iridescent((x / width) * 0.8 + (y / PICTURE) * 0.4)
      for (let k = 0; k < 4; k++) {
        const p = (at[k] as number) * 3
        const v = ws[k] as number
        tint[p] = (tint[p] as number) + v * r
        tint[p + 1] = (tint[p + 1] as number) + v * g
        tint[p + 2] = (tint[p + 2] as number) + v * b
      }
    } else
      for (let k = 0; k < 4; k++)
        white[at[k] as number] = (white[at[k] as number] as number) + (ws[k] as number)
  }

  const nowX = new Float32Array(COUNT)
  const nowY = new Float32Array(COUNT)
  return {
    async render(t, o) {
      white.fill(0)
      tint.fill(0)
      for (let i = 0; i < COUNT; i++) {
        place(i, t)
        nowX[i] = out[0] as number
        nowY[i] = out[1] as number
        splat(i, nowX[i] as number, nowY[i] as number, 1)
      }
      // The trail, only where a particle moved: a held letter stays crisp.
      for (const [j, back] of TRAIL.entries()) {
        const w = 0.42 / (j + 1)
        for (let i = 0; i < COUNT; i++) {
          place(i, t - back)
          const x = out[0] as number
          const y = out[1] as number
          if (Math.abs(x - (nowX[i] as number)) + Math.abs(y - (nowY[i] as number)) < 1.5) continue
          splat(i, x, y, w)
        }
      }
      // Premultiplied, so the index number behind shows through the dark.
      for (let p = 0, q = 0; p < white.length; p++, q += 4) {
        const wv = 1 - Math.exp(-0.38 * (white[p] as number))
        const r = Math.min(1, wv + 1 - Math.exp(-1.1 * (tint[p * 3] as number)))
        const g = Math.min(1, wv + 1 - Math.exp(-1.1 * (tint[p * 3 + 1] as number)))
        const b = Math.min(1, wv + 1 - Math.exp(-1.1 * (tint[p * 3 + 2] as number)))
        pixels[q] = 255 * r
        pixels[q + 1] = 255 * g
        pixels[q + 2] = 255 * b
        pixels[q + 3] = 255 * Math.max(r, g, b)
      }

      uctx.fillStyle = '#000'
      uctx.fillRect(0, 0, width, height)
      behind.index()

      // The type over it: the corner words, the note, the marks of the word that holds, the labels.
      const s = state(t)
      const set = setAt(s.n)
      ctx.clearRect(0, 0, width, height)
      theme.words(TOPS, BOTTOMS, t, o.frame)
      theme.notes(NOTES, t, o.frame)
      const shown =
        ease((s.since - FLIGHT - SWEEP) / 0.2) * (1 - ease((s.since - STEP + 0.1) / 0.1))
      if (shown > 0) {
        const open = spread(s.since)
        const n = set.marks.length
        ctx.globalAlpha = shown
        ctx.font = `14px ${mono}`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        const base = set.bottom + 44
        for (const [c, m] of [...set.marks, set.right].entries()) {
          const char = Math.min(c, n - 1)
          const off =
            set.phrase.split !== undefined
              ? (char >= set.phrase.split ? 1 : -1) * SPLIT_APART
              : (char - (n - 1) / 2) * STEP_APART
          const x = m - (m - width / 2) * set.shrink * open + off * open
          const lit = set.phrase.split !== undefined && c === set.phrase.split
          ctx.fillStyle = RED
          ctx.fillRect(Math.round(x), base - (lit ? 40 : 20), lit ? 3 : 2, lit ? 40 : 20)
          if (c < n) {
            ctx.fillStyle = lit ? '#fff' : '#8a8a8a'
            ctx.fillText(
              `${c}  ${(set.points.marks[c] ?? 0).toFixed(3)}`,
              Math.max(L, x + 6),
              base - 4,
            )
          }
        }
        ctx.globalAlpha = 1
      }
      theme.hud(
        t,
        o.frame,
        `POINTS ${COUNT.toLocaleString('en-US')}   ASPECT ${set.points.aspect.toFixed(3)}`,
        `SEED ${s.index}   MARKS ${set.marks.length}`,
      )
      return [
        { color: under, name: 'index' },
        { color: pixels, alpha: 'premultiplied', name: 'points' },
        { color: overlay, name: 'type' },
      ]
    },
    status(t) {
      const s = state(t)
      return `${String(s.index + 1).padStart(2, '0')}/04  ${setAt(s.n).phrase.text}`
    },
    inspect(t) {
      const s = state(t)
      const set = setAt(s.n)
      return {
        id: 'points',
        text: set.phrase.text,
        count: COUNT,
        aspect: set.points.aspect,
        marks: set.points.marks,
        spread: spread(s.since),
      }
    },
  }
}

export default textGlyphPoints
