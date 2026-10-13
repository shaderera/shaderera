// font-stix-two-text: an animated specimen of the plugin's two variable fonts, white on black. A
// giant glyph cuts every 0.375 s (roman for a beat of four, then italic) while its weight morphs
// along the font's own wght axis, 400 to 700, measured against the face's metric lines and tracked
// by a red box; a waterfall of sizes beside it carries a weight wave down its lines, and a line of
// the mathematical voice slides under them. Only glyphs the Text fonts have (no ∂ ∫ ∑ √ ∞: those
// are STIX Two Math's).

import { createHouse, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const ROMAN = 'STIX Two Text'
const ITALIC = 'STIX Two Text Italic'
const L = 48
const R = 1032
const TAU = Math.PI * 2
const CUT = 0.375
/** The face's metrics per em (OS/2 and hhea of STIXTwoText[wght].ttf). */
const METRICS = { ascender: 0.762, cap: 0.657, xHeight: 0.473, descender: -0.238 }
const GROUPS: { italic: boolean; word: string; note: string; glyphs: [string, string][] }[] = [
  {
    italic: false,
    word: 'ROMAN',
    note: 'a scientific serif, for notes beside a monospace',
    glyphs: [
      ['A', 'LATIN CAPITAL LETTER A'],
      ['g', 'LATIN SMALL LETTER G'],
      ['&', 'AMPERSAND'],
      ['Ω', 'GREEK CAPITAL LETTER OMEGA'],
    ],
  },
  {
    italic: true,
    word: 'ITALIC',
    note: 'the italic, for the mathematical voice',
    glyphs: [
      ['f', 'LATIN SMALL LETTER F'],
      ['λ', 'GREEK SMALL LETTER LAMDA'],
      ['ψ', 'GREEK SMALL LETTER PSI'],
      ['ħ', 'LATIN SMALL LETTER H WITH STROKE'],
    ],
  },
  {
    italic: false,
    word: 'GREEK',
    note: 'Greek and symbols drawn to the same weight',
    glyphs: [
      ['R', 'LATIN CAPITAL LETTER R'],
      ['Σ', 'GREEK CAPITAL LETTER SIGMA'],
      ['§', 'SECTION SIGN'],
      ['ß', 'LATIN SMALL LETTER SHARP S'],
    ],
  },
  {
    italic: true,
    word: 'WEIGHT',
    note: 'one variable axis, from 400 to 700',
    glyphs: [
      ['Q', 'LATIN CAPITAL LETTER Q'],
      ['ω', 'GREEK SMALL LETTER OMEGA'],
      ['e', 'LATIN SMALL LETTER E'],
      ['½', 'VULGAR FRACTION ONE HALF'],
    ],
  },
]
const WATERFALL = 'The quick brown fox jumps over the lazy dog 0123456789'
const MATH = 'E = mc²   ·   λ = h/p   ·   ψ(x, t)   ·   F = ma   ·   ½ħω   ·   α + β = γ   ·   '

type VarCtx = OffscreenCanvasRenderingContext2D & { fontVariationSettings: string }

const fontStixTwoText: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`font-stix-two-text has no state "${stateId}"`)
  await host.io.font('assets/fonts/STIXTwoText[wght].ttf', ROMAN)
  await host.io.font('assets/fonts/STIXTwoText-Italic[wght].ttf', ITALIC)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as VarCtx
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`
  /** Sets a STIX face at a size and weight; `normal` again for every other font. */
  const stix = (italic: boolean, size: number, weight: number) => {
    ctx.font = `${size}px "${italic ? ITALIC : ROMAN}"`
    ctx.fontVariationSettings = `'wght' ${weight.toFixed(1)}`
  }
  const plain = () => {
    ctx.fontVariationSettings = 'normal'
  }

  const state = (t: number) => {
    const n = Math.floor(t / CUT)
    const g = Math.floor(n / 4) % GROUPS.length
    const group = GROUPS[g] as (typeof GROUPS)[number]
    const [glyph, name] = group.glyphs[n % 4] as [string, string]
    // The weight: a whole number of swings a loop, so t 6 is t 0.
    const weight = 550 + 150 * Math.sin((t / duration) * TAU * 4 - Math.PI / 2)
    return {
      group,
      glyph,
      name,
      weight,
      since: t - n * CUT,
      groupSince: t - Math.floor(n / 4) * 4 * CUT,
    }
  }

  const drawGlyph = (s: ReturnType<typeof state>) => {
    const size = 460
    const base = 590
    const x0 = L
    const x1 = 600
    // The metric lines, labelled.
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    for (const [key, v] of Object.entries(METRICS)) {
      const y = Math.round(base - v * size) + 0.5
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.fillRect(x0, y, x1 - x0, 1)
      ctx.fillStyle = '#8a8a8a'
      ctx.fillText(key.toUpperCase(), x1 - ctx.measureText(key.toUpperCase()).width, y - 6)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillRect(x0, base, x1 - x0, 1)
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText('BASELINE', x1 - ctx.measureText('BASELINE').width, base - 6)
    // The glyph, punched in on its cut.
    const punch = 1 + 0.08 * Math.exp(-s.since / 0.06)
    stix(s.group.italic, size * punch, s.weight)
    const m = ctx.measureText(s.glyph)
    const gx = 70 + (420 - m.width) / 2
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'left'
    ctx.fillText(s.glyph, gx, base)
    // The red tracking box round its ink.
    const bx = gx - m.actualBoundingBoxLeft - 10
    const by = base - m.actualBoundingBoxAscent - 10
    const bw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight + 20
    const bh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 20
    plain()
    ctx.fillStyle = RED
    const k = 18
    for (const [px, py, dx, dy] of [
      [bx, by, 1, 1],
      [bx + bw, by, -1, 1],
      [bx, by + bh, 1, -1],
      [bx + bw, by + bh, -1, -1],
    ] as const) {
      ctx.fillRect(dx > 0 ? px : px - k, dy > 0 ? py : py - 2, k, 2)
      ctx.fillRect(dx > 0 ? px : px - 2, dy > 0 ? py : py - k, 2, k)
    }
    const code = `U+${(s.glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    ctx.font = `13px ${mono}`
    ctx.fillStyle = '#000'
    const lw = ctx.measureText(code).width + 8
    ctx.fillStyle = RED
    ctx.fillRect(bx, by - 20, lw, 18)
    ctx.fillStyle = '#000'
    ctx.fillText(code, bx + 4, by - 6)
  }

  // A waterfall of sizes, a weight wave running down its lines, roman and italic alternating.
  const drawWaterfall = (t: number) => {
    const x0 = 640
    const sizes = [66, 48, 36, 28, 22, 17, 14, 12]
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, 140, R - x0, 556)
    ctx.clip()
    let y = 200
    sizes.forEach((size, i) => {
      const w = 550 + 150 * Math.sin((t / duration) * TAU * 3 - i * 0.7)
      stix(i % 2 === 1, size, w)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'left'
      const drift = ((t / duration) * 2 * size * (i % 2 ? 1 : -1)) % (size * 4)
      ctx.fillText(WATERFALL, x0 + drift - (i % 2 ? size * 4 : 0), y)
      plain()
      ctx.font = `11px ${mono}`
      ctx.fillStyle = '#6a6a6a'
      ctx.fillText(`${size}  ${Math.round(w)}`, x0, y + 16)
      y += size * 1.05 + 26
    })
    ctx.restore()
  }

  // The mathematical voice, sliding left a whole repeat a loop.
  const drawMath = (t: number) => {
    stix(true, 40, 480)
    const rep = ctx.measureText(MATH).width
    const x = L - (((t / duration) * rep) % rep)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'left'
    ctx.save()
    ctx.beginPath()
    ctx.rect(L, 712, R - L, 50)
    ctx.clip()
    for (let k = 0; k < 3; k++) ctx.fillText(MATH, x + k * rep, 750)
    ctx.restore()
    plain()
    ctx.fillStyle = 'rgba(255,255,255,0.28)'
    ctx.fillRect(L, 712, R - L, 1)
  }

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      drawGlyph(s)
      drawWaterfall(t)
      drawMath(t)
      plain()
      house.bigWord({
        text: s.group.word,
        corner: 'tl',
        since: s.groupSince,
        until: 4 * CUT - s.groupSince,
        frame: o.frame,
      })
      house.bigWord({
        text: `WGHT ${Math.round(s.weight)}`,
        corner: 'br',
        since: 9,
        frame: o.frame,
      })
      house.note(s.group.note)
      house.hud(
        t,
        o.frame,
        `U+${(s.glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}  ${s.name}`,
        s.group.italic ? 'STIXTwoText-Italic[wght].ttf' : 'STIXTwoText[wght].ttf',
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${s.group.italic ? 'italic' : 'roman'}  wght ${Math.round(s.weight)}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'specimen', glyph: s.glyph, italic: s.group.italic, weight: s.weight }
    },
  }
}

export default fontStixTwoText
