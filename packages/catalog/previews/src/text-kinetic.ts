// text-kinetic: a Swiss type poster that rewrites itself. In the 'all' state four phrases, one each 1.5 s, say what
// the item does, and each shows it: SCRAMBLE EVERY LETTER flickers through ASCII, DECODE INTO
// PLACE resolves character by character, GLITCH THE SIGNAL is cut into thrown bands, FIT ANY
// WIDTH refits every line as the column narrows and widens. Every line is sized with fitWidth to
// the column, and the column to the frame, so the block reflows as the words change.

import { FONT, type OpenPreview } from './preview.ts'
import { decoded, fitWidth, glitched, hollow, rnd, scramble, timecode } from './type/kinetic.ts'

type Effect = 'scramble' | 'decode' | 'glitch' | 'fit'
type Phrase = { id: Effect; lines: string[] }

/** 'all' says what the item does; a state shows one primitive through four phrases. */
const STATES: Record<string, Phrase[]> = {
  all: [
    { id: 'scramble', lines: ['SCRAMBLE', 'EVERY', 'LETTER'] },
    { id: 'decode', lines: ['DECODE', 'INTO', 'PLACE'] },
    { id: 'glitch', lines: ['GLITCH', 'THE', 'SIGNAL'] },
    { id: 'fit', lines: ['FIT', 'ANY', 'WIDTH'] },
  ],
  scramble: [
    { id: 'scramble', lines: ['SCRAMBLE', 'EVERY', 'LETTER'] },
    { id: 'scramble', lines: ['NOISE', 'IN THE', 'TYPE'] },
    { id: 'scramble', lines: ['NEVER', 'QUITE', 'SETTLED'] },
    { id: 'scramble', lines: ['ASCII', 'ALL THE', 'WAY'] },
  ],
  decode: [
    { id: 'decode', lines: ['LETTER', 'BY', 'LETTER'] },
    { id: 'decode', lines: ['OUT OF', 'ASCII', 'NOISE'] },
    { id: 'decode', lines: ['READ IT', 'AS IT', 'LANDS'] },
    { id: 'decode', lines: ['DECODE', 'INTO', 'PLACE'] },
  ],
  glitch: [
    { id: 'glitch', lines: ['GLITCH', 'THE', 'SIGNAL'] },
    { id: 'glitch', lines: ['CUT', 'INTO', 'BANDS'] },
    { id: 'glitch', lines: ['THROWN', 'SIDE', 'WAYS'] },
    { id: 'glitch', lines: ['BREAK', 'THE', 'LINE'] },
  ],
}
const STEP = 1.5
/** Each line swaps this much after the one above it. */
const CASCADE = 0.06
/** How long a line takes to change size when its word changes. */
const MORPH = 0.32
const AREA = { left: 48, top: 118, right: 1032, bottom: 860, gap: 22 }

const ease = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

const textKinetic: OpenPreview = async (host, stateId) => {
  const PHRASES = STATES[stateId]
  if (!PHRASES) throw new Error(`text-kinetic has no state "${stateId}"`)
  const first = PHRASES[0] as Phrase
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const font = `"${FONT.sansMedium}"`
  const mono = `"${FONT.mono}"`

  // Each word's ink at 100 px: its width, and its height above and below a middle baseline.
  const metrics = new Map<string, { width: number; up: number; down: number }>()
  ctx.textBaseline = 'middle'
  for (const p of Object.values(STATES).flat())
    for (const w of p.lines) {
      ctx.font = `100px ${font}`
      const m = ctx.measureText(w)
      metrics.set(w, {
        width: 100 * (100 / fitWidth(ctx, font, w, 100)),
        up: m.actualBoundingBoxAscent,
        down: m.actualBoundingBoxDescent,
      })
    }
  const metric = (w: string) => metrics.get(w) ?? { width: 100, up: 35, down: 35 }

  const state = (t: number, frame: number) => {
    const n = Math.floor(t / STEP)
    const phrase = PHRASES[n % PHRASES.length] ?? first
    const since = t - n * STEP
    // Phrase 4 sweeps the column's width; the others keep it at the frame's.
    const sweep =
      phrase.id === 'fit' ? 0.5 + 0.5 * Math.cos(((since - 0.25) / 1.1) * Math.PI * 2) : 1
    const maxWidth =
      (AREA.right - AREA.left) * (since < 0.25 || phrase.id !== 'fit' ? 1 : 0.42 + 0.58 * sweep)
    const lines = phrase.lines.map((word, j) => {
      const start = n * STEP + j * (phrase.id === 'decode' ? 0.18 : CASCADE)
      const prev = (PHRASES[(n + PHRASES.length - 1) % PHRASES.length] ?? first).lines[j] ?? word
      const k = ease((t - start) / MORPH)
      const a = metric(prev)
      const b = metric(word)
      // Height per px of column width, blended from the last word's to this one's.
      const per = (1 - k) * ((a.up + a.down) / a.width) + k * ((b.up + b.down) / b.width)
      const up = (1 - k) * (a.up / a.width) + k * (b.up / b.width)
      const rise = phrase.id === 'decode' ? 0.6 : 0.28
      const d = decoded(word, t, {
        from: start,
        to: (n + 1) * STEP + j * CASCADE,
        frame,
        seed: n * 7 + j,
        rise,
        fall: 0.12,
        swap: true,
      })
      return { id: `line-${j}`, word, text: d.text, settled: d.settled, per, up, k }
    })
    const column = Math.min(
      maxWidth,
      (AREA.bottom - AREA.top - AREA.gap * (lines.length - 1)) /
        lines.reduce((s, l) => s + l.per, 0),
    )
    let y = AREA.top
    const placed = lines.map((l) => {
      const h = l.per * column
      const size = (100 * column) / metric(l.word).width
      const mid = y + l.up * column
      const box = [AREA.left, y, column, h]
      y += h + AREA.gap
      return { ...l, size, mid, box }
    })
    // GLITCH hits on its downbeat and again half way; the flash inverts the frame for 3 frames.
    const hit = phrase.id === 'glitch' && (since < 0.1 || (since > 0.75 && since < 0.82))
    const glitch =
      phrase.id === 'glitch' ? 0.55 + 0.45 * Math.exp(-since / 0.25) : Math.exp(-since / 0.08) * 0.8
    const share = phrase.id === 'scramble' ? 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(since * 14)) : 0
    return {
      phrase: phrase.id,
      index: n % PHRASES.length,
      since,
      column,
      lines: placed,
      hit,
      glitch,
      share,
    }
  }

  return {
    async render(t, o) {
      const s = state(t, o.frame)
      const ink = s.hit ? '#000' : '#fff'
      ctx.fillStyle = s.hit ? '#fff' : '#000'
      ctx.fillRect(0, 0, width, height)

      // The phrase's number, huge and hollow behind the block.
      hollow(ctx, String(s.index + 1).padStart(2, '0'), width + 40, 900, {
        font: `"${FONT.sansLight}"`,
        size: 760,
        align: 'right',
        color: s.hit ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.22)',
        width: 2,
      })

      // The header: timecode and the live measurements, numbers that never settle.
      ctx.fillStyle = s.hit ? '#000' : '#8a8a8a'
      ctx.font = `22px ${mono}`
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      ctx.fillText(scramble(`T ${timecode(t)}`, o.frame, 0.08), AREA.left, 70)
      ctx.textAlign = 'right'
      const first = s.lines[0]
      ctx.fillText(
        scramble(
          `COLUMN ${Math.round(s.column)} PX   SIZE ${(first?.size ?? 0).toFixed(1)} PX`,
          o.frame,
          0.1,
        ),
        AREA.right,
        70,
      )
      ctx.fillRect(AREA.left, 88, AREA.right - AREA.left, 2)

      // The block: each line fitted to the column.
      ctx.fillStyle = ink
      for (const [j, l] of s.lines.entries()) {
        const text = s.share > 0 ? scramble(l.text, o.frame + j * 3, s.share) : l.text
        const amount =
          s.phrase === 'glitch' ? s.glitch * (rnd(o.frame * 3 + j) < 0.8 ? 1 : 0) : s.glitch
        glitched(ctx, text, AREA.left, l.mid, {
          font,
          size: l.size,
          frame: o.frame + j * 11,
          amount,
          bands: s.phrase === 'glitch' ? 11 : 7,
        })
      }
      // The column's right edge, so the fit is seen.
      ctx.fillStyle = s.hit ? '#000' : '#ff3b1f'
      ctx.fillRect(AREA.left + s.column + 10, AREA.top, 3, AREA.bottom - AREA.top)
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t, Math.round(t * Number(host.manifest.fps)))
      return `${String(s.index + 1).padStart(2, '0')}/04  ${s.phrase}`
    },
    inspect(t) {
      const s = state(t, Math.round(t * Number(host.manifest.fps)))
      return {
        id: 'poster',
        phrase: s.phrase,
        column: s.column,
        lines: s.lines.map((l) => ({
          id: l.id,
          text: l.text,
          box: l.box,
          font: `${l.size.toFixed(1)}px ${font}`,
        })),
      }
    },
  }
}

export default textKinetic
