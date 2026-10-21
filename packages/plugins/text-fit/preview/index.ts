// text-fit: the plugin's calls on plain white text, one at a time, each labelled with its call and
// its answer. A width (or a tracking) swings once over the loop and the plugin answers it on every
// frame: fitWidth and fitSize size three texts to the width, wrap breaks a paragraph into lines no
// wider than it, and trackedWidth measures a word at three trackings. Red marks the width, or the
// measured one. In the 'all' state each call holds 2 s, with a hard cut to the next; a state holds
// one for the loop. The plugin draws nothing, so the preview draws the text itself.

import { createHouse, L, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { fitSize, fitWidth, trackedWidth, wrap } from '../../previews/src/type/fit.ts'

type Call = 'fit' | 'wrap' | 'track'

const STATES: Record<string, Call[]> = {
  all: ['fit', 'wrap', 'track'],
  fit: ['fit'],
  wrap: ['wrap'],
  track: ['track'],
}

/** Each call: its corner words and a note. */
const CALLS: Record<Call, { name: string; varies: string; note: string }> = {
  fit: { name: 'FITWIDTH', varies: 'WIDTH', note: 'the size that sets the text this wide' },
  wrap: { name: 'WRAP', varies: 'WIDTH', note: 'greedy, between words, never through one' },
  track: {
    name: 'TRACKEDWIDTH',
    varies: 'TRACKING',
    note: 'a line measured with space between letters',
  },
}
const FIT_TEXTS = ['ANY WIDTH', 'SIZED TO FIT', 'THE SIZE THAT FITS']
/** fitSize's largest size, on the last row: it stops growing there. */
const FIT_CAP = 70
const PARAGRAPH =
  'Words come from Intl.Segmenter, so a line breaks only between words, and punctuation stays ' +
  'with its word. A word wider than the column, like supercalifragilisticexpialidocious, gets a line of its own.'
const TRACK_WORD = 'SPACED'
const TRACK_ROWS = [0.5, 1, 1.5]
/** The rows: the top of the first and the pitch. */
const ROW = { top: 172, pitch: 200 }

const textFit: OpenPreview = async (host, stateId) => {
  const calls = STATES[stateId]
  if (!calls) throw new Error(`text-fit has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const bold = `"${FONT.monoBold}"`
  const sans = `"${FONT.sans}"`
  const medium = `"${FONT.sansMedium}"`
  const mono = `"${FONT.mono}"`
  const step = duration / calls.length

  const spans = (pick: (c: Call) => string): Word[] =>
    calls.map((c, i) => ({ from: i * step, to: (i + 1) * step, text: pick(c) }))
  const TOPS = spans((c) => CALLS[c].name)
  const BOTTOMS = spans((c) => CALLS[c].varies)
  const NOTES = spans((c) => CALLS[c].note)

  const callAt = (t: number) => calls[Math.floor(t / step) % calls.length] ?? 'fit'
  /** Once round the loop, so the last frame meets the first: 0 → 1 → 0. */
  const swing = (t: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / duration)

  const label = (text: string, y: number) => {
    ctx.font = `16px ${mono}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#9a9a9a'
    ctx.fillText(text, L, y)
  }
  /** Red ticks at a measured width's two edges. */
  const ticks = (w: number, mid: number, h: number) => {
    ctx.fillStyle = RED
    ctx.fillRect(L - 1, mid - h / 2, 2, h)
    ctx.fillRect(L + w - 1, mid - h / 2, 2, h)
  }

  return {
    async render(t, o) {
      const call = callAt(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      let measure = ''
      if (call === 'fit') {
        const w = Math.round(320 + 380 * swing(t))
        for (const [j, text] of FIT_TEXTS.entries()) {
          const top = ROW.top + j * ROW.pitch
          const last = j === FIT_TEXTS.length - 1
          const size = last ? fitSize(ctx, bold, text, FIT_CAP, w) : fitWidth(ctx, bold, text, w)
          label(
            last
              ? `fitSize(ctx, font, '${text}', ${FIT_CAP}, ${w})  →  ${size.toFixed(1)}`
              : `fitWidth(ctx, font, '${text}', ${w})  →  ${size.toFixed(1)}`,
            top + 16,
          )
          const mid = top + 40 + Math.min(size, 150) * 0.5
          ctx.font = `${size}px ${bold}`
          ctx.textBaseline = 'middle'
          ctx.fillStyle = '#fff'
          ctx.fillText(text, L, mid)
          ticks(w, mid, size * 0.84)
        }
        measure = `WIDTH ${w} PX`
      } else if (call === 'wrap') {
        const w = Math.round(360 + 620 * swing(t))
        ctx.font = `36px ${sans}`
        const lines = wrap(ctx, PARAGRAPH, w)
        label(`wrap(ctx, text, ${w})  →  ${lines.length} lines`, ROW.top + 16)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = '#fff'
        for (const [i, line] of lines.entries()) ctx.fillText(line, L, ROW.top + 80 + i * 48)
        ticks(w, ROW.top + 80 + ((lines.length - 1) * 48) / 2 - 12, lines.length * 48 + 24)
        measure = `WIDTH ${w} PX`
      } else {
        const tracking = 60 * swing(t)
        for (const [j, k] of TRACK_ROWS.entries()) {
          const top = ROW.top + j * ROW.pitch
          const tr = tracking * k
          ctx.font = `100px ${medium}`
          const w = trackedWidth(ctx, TRACK_WORD, tr)
          label(
            `trackedWidth(ctx, '${TRACK_WORD}', ${tr.toFixed(1)})  →  ${w.toFixed(1)}`,
            top + 16,
          )
          const mid = top + 90
          ctx.letterSpacing = `${tr}px`
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = '#fff'
          ctx.fillText(TRACK_WORD, L, mid)
          ctx.letterSpacing = '0px'
          ticks(w, mid, 84)
        }
        measure = `TRACKING ${tracking.toFixed(1)} PX`
      }

      house.words(TOPS, BOTTOMS, t, o.frame)
      house.notes(NOTES, t, o.frame)
      house.hud(t, o.frame, measure)
      return [{ color: canvas }]
    },
    status(t) {
      return callAt(t)
    },
    inspect(t) {
      return { id: 'fit', call: callAt(t) }
    },
  }
}

export default textFit
