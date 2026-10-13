// text-feature-captions: the item's captions over a moving picture, eight to a loop, one every two
// beats at 160 BPM, each saying what the item does while it does it, its notes in Instrument Serif
// Italic as the house style sets them. The picture is a procedural terrain of luminous lines
// rushing at the camera, its hidden lines removed, a wave raised on every swap and one pastel
// line riding it. In the 'all' state each caption is set in the next of the four
// layouts (edge, split, column, spine); a state keeps every caption in one. The captions run
// from a loop before to a loop after, so every change, the seam included, is a swap through
// ASCII noise.

import { createHouse, iridescent, SERIF } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import type { Layout } from '../../previews/src/type/captions.ts'
import { createCaptions } from '../../previews/src/type/captions.ts'

const SWAP = (2 * 60) / 160
const PICTURE = 904
const ITEMS: [string, string][] = [
  ['HUGE TITLES', 'a small note beside each'],
  ['ON THE BEAT', 'two beats a caption'],
  ['THROUGH NOISE', 'every swap decodes in ASCII'],
  ['FOUR LAYOUTS', 'edge, split, column, spine'],
  ['SAFE AREA', 'inside the title-safe margins'],
  ['HOLLOW NUMBERS', 'the count, huge, behind'],
  ['ANY FORMAT', 'square, wide or tall'],
  ['NAME IT', 'while the picture does it'],
]
const LAYOUTS: Record<string, Layout[]> = {
  all: ['edge', 'split', 'column', 'spine'],
  edge: ['edge'],
  split: ['split'],
  column: ['column'],
  spine: ['spine'],
}

// The terrain: rows of a height field moving at the camera, whole rows per loop so it repeats.
const ROWS = 110
const PERIOD = 192
const SPACING = 0.16
const NEAR = 0.7
const POINTS = 160
const HORIZON = 210
const FOCAL = 760
const EYE = 2.4

const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
// Value noise that repeats every `p` cells along y.
const lattice = (x: number, y: number, p: number) =>
  hash((x & 4095) * 7919 + (((y % p) + p) % p) * 104729 + 3) / 4294967296
const noise = (x: number, y: number, p: number) => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = lattice(xi, yi, p)
  const b = lattice(xi + 1, yi, p)
  const c = lattice(xi, yi + 1, p)
  const d = lattice(xi + 1, yi + 1, p)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

const textFeatureCaptions: OpenPreview = async (host, stateId) => {
  const layouts = LAYOUTS[stateId]
  if (!layouts) throw new Error(`text-feature-captions has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const picture = host.io.canvas(width, PICTURE)
  const pctx = picture.getContext('2d') as OffscreenCanvasRenderingContext2D
  const captions = createCaptions({
    captions: [{ from: -duration, to: 2 * duration, items: ITEMS }],
    fonts: { title: `"${FONT.monoBold}"`, small: `"${FONT.mono}"`, note: `"${SERIF}"` },
    swap: SWAP,
    layouts,
  })

  // Heights per row (in whole rows of the period) and point across, made once.
  const heights = new Float32Array(PERIOD * POINTS)
  for (let r = 0; r < PERIOD; r++)
    for (let k = 0; k < POINTS; k++) {
      const x = k / (POINTS - 1)
      const ridge = 1 - Math.abs(noise(x * 7, r * 0.125, PERIOD * 0.125) * 2 - 1)
      const fine = noise(x * 19 + 40, r * 0.25, PERIOD * 0.25)
      // Flatter down the middle, where the captions sit, rising to the sides.
      const side = 0.35 + 0.65 * Math.abs(x - 0.5) * 2
      heights[r * POINTS + k] = (ridge ** 2 * 1.3 + fine * 0.35) * side
    }

  const state = (t: number) => {
    const n = Math.floor(t / SWAP)
    const since = t - n * SWAP
    const index = ((n % ITEMS.length) + ITEMS.length) % ITEMS.length
    return { n, since, index, layout: layouts[index % layouts.length] ?? 'edge' }
  }

  const terrain = (t: number) => {
    const s = state(t)
    const scroll = (t / duration) * PERIOD
    const base = Math.floor(scroll)
    const frac = scroll - base
    pctx.fillStyle = '#000'
    pctx.fillRect(0, 0, width, PICTURE)
    // The swap's wave: raised at the camera on the swap, travelling away.
    const wave = (z: number) => {
      const front = NEAR + s.since * 14
      const d = z - front
      return Math.exp(-d * d * 0.9) * Math.exp(-s.since * 1.2)
    }
    const xs = new Float32Array(POINTS)
    const ys = new Float32Array(POINTS)
    for (let j = ROWS - 1; j >= 0; j--) {
      const z = NEAR + (j + 1 - frac) * SPACING
      const row = (((base + j) % PERIOD) + PERIOD) % PERIOD
      const lift = 1 + 2.2 * wave(z)
      for (let k = 0; k < POINTS; k++) {
        const x = (k / (POINTS - 1) - 0.5) * 16
        const h = (heights[row * POINTS + k] as number) * lift
        xs[k] = width / 2 + (x * FOCAL) / z / 2.2
        ys[k] = HORIZON + ((EYE - h) * FOCAL) / z / 2.2
      }
      // Hide what is behind: fill under the line black, then draw it.
      pctx.beginPath()
      pctx.moveTo(xs[0] as number, PICTURE)
      for (let k = 0; k < POINTS; k++) pctx.lineTo(xs[k] as number, ys[k] as number)
      pctx.lineTo(xs[POINTS - 1] as number, PICTURE)
      pctx.closePath()
      pctx.fillStyle = '#000'
      pctx.fill()
      const fade = Math.min(1, (ROWS - j) / 30) * Math.min(1, (j + 1 - frac) / 3)
      const lit = row === (s.n * 24 + 60) % PERIOD
      const glow = (0.36 + 0.64 * wave(z)) * fade
      pctx.beginPath()
      for (let k = 0; k < POINTS; k++) pctx.lineTo(xs[k] as number, ys[k] as number)
      if (lit) {
        // The one line in the film's pastel, wide and soft under a bright core.
        const [r, g, b] = iridescent(s.n * 0.13).map((c) => Math.round(c * 255)) as [
          number,
          number,
          number,
        ]
        pctx.lineWidth = 9
        pctx.strokeStyle = `rgba(${r},${g},${b},${0.25 * fade})`
        pctx.stroke()
        pctx.lineWidth = 2.5
        pctx.strokeStyle = `rgba(${r},${g},${b},${fade})`
        pctx.stroke()
      } else {
        pctx.lineWidth = 4
        pctx.strokeStyle = `rgba(255,255,255,${0.07 * glow})`
        pctx.stroke()
        pctx.lineWidth = 1.25
        pctx.strokeStyle = `rgba(225,225,225,${glow})`
        pctx.stroke()
      }
    }
  }

  return {
    async render(t, o) {
      terrain(t)
      captions(pctx, width, PICTURE, t, o.frame)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(picture, 0, 0)
      const st = state(t)
      theme.hud(
        t,
        o.frame,
        `${String(st.index + 1).padStart(2, '0')}/08 ${st.layout.toUpperCase()}`,
        '',
        'top-right',
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${String(s.index + 1).padStart(2, '0')}/08  ${s.layout}`
    },
    inspect(t) {
      const s = state(t)
      const [title, note] = ITEMS[s.index] ?? ['', '']
      return { id: 'caption', index: s.index, layout: s.layout, title, note }
    },
  }
}

export default textFeatureCaptions
