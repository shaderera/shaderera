// Text measured and laid out in a width on a Canvas2D context: the size that fits a width, lines
// wrapped greedily at word boundaries, a line's width at a tracking, and the lines as the text runs
// review reads from inspect. Words come from Intl.Segmenter, so text without spaces between words
// (Thai, Chinese, Japanese) wraps too. No hyphenation, bidi or kinsoku. It draws nothing: wrap and
// trackedWidth measure in the font the context already has, and fitWidth and textRuns put the font
// back as they found it.

type Ctx = OffscreenCanvasRenderingContext2D

/** The size at which `text` in `font` (a family alone: '"IBM Plex Mono"') is `width` wide. */
export const fitWidth = (ctx: Ctx, font: string, text: string, width: number) => {
  const was = ctx.font
  ctx.font = `100px ${font}`
  const w = ctx.measureText(text).width
  ctx.font = was
  return (100 * width) / Math.max(1, w)
}

/** `size`, or smaller if text at that size would be wider than `room`. */
export const fitSize = (ctx: Ctx, font: string, text: string, size: number, room: number) =>
  Math.min(size, fitWidth(ctx, font, text, room))

const segmenters = new Map<string, Intl.Segmenter>()
const segmenter = (granularity: 'grapheme' | 'word', locale?: string) => {
  const key = `${granularity} ${locale ?? ''}`
  const s = segmenters.get(key) ?? new Intl.Segmenter(locale, { granularity })
  segmenters.set(key, s)
  return s
}

/**
 * The width of `text` in the context's font with `tracking` px added between each pair of
 * characters (graphemes, so a Thai vowel or tone mark stays with its consonant): what
 * `ctx.letterSpacing` draws, less the space after the last character.
 */
export const trackedWidth = (ctx: Ctx, text: string, tracking = 0, locale?: string) => {
  const w = ctx.measureText(text).width
  if (!tracking || !text) return w
  const n = [...segmenter('grapheme', locale).segment(text)].length
  return w + tracking * (n - 1)
}

/**
 * `text` broken into lines no wider than `width` in the context's font, greedily: each line takes
 * as many words as fit, and punctuation stays with its word. A word wider than `width` gets a
 * line of its own and is not broken. `\n` starts a new line; spaces at a break are dropped.
 * `locale` picks Intl.Segmenter's word rules ('th' for Thai); `tracking` is as in trackedWidth.
 */
export const wrap = (
  ctx: Ctx,
  text: string,
  width: number,
  o: { tracking?: number; locale?: string } = {},
) => {
  const measure = (s: string) => trackedWidth(ctx, s, o.tracking, o.locale)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    // The pieces a line may break between: a word with the punctuation and spaces after it. A
    // break comes before a word unless punctuation is right before it ('(word', 'foo-bar'), and
    // before punctuation only after a space.
    const pieces: string[] = []
    let prev: 'blank' | 'word' | 'mark' = 'blank'
    for (const { segment, isWordLike } of segmenter('word', o.locale).segment(paragraph)) {
      const kind = !segment.trim() ? 'blank' : isWordLike ? 'word' : 'mark'
      const breaks = kind === 'word' ? prev !== 'mark' : kind === 'mark' && prev === 'blank'
      if (breaks || !pieces.length) pieces.push(segment)
      else pieces[pieces.length - 1] += segment
      prev = kind
    }
    let line = ''
    for (const piece of pieces) {
      if (line.trim() && measure((line + piece).trimEnd()) > width) {
        lines.push(line.trimEnd())
        line = piece.trimStart()
      } else line += piece
    }
    lines.push(line.trimEnd())
  }
  return lines
}

/** A text run as inspect gives it to review: docs/protocol.md, "Text runs". */
export type TextRun = {
  id: string
  text: string
  /** [x, y, width, height] in frame pixels, from the top left. */
  box: [number, number, number, number]
  font: string
}

/**
 * The text runs for `lines` set from `origin` (the top left of the text box), one a line, for the
 * film's inspect: review reads them for its text checks. Line i's box is `lineHeight` tall from
 * y + i × lineHeight, and as wide as the line measures in `font` (the context's font when left out)
 * at `tracking`; `align` places it in a box `width` wide. Ids are `${id}.${i}`; a blank line
 * makes no run but keeps its place. It measures only: draw the lines where their boxes say.
 */
export const textRuns = (
  ctx: Ctx,
  lines: readonly string[],
  origin: readonly [number, number],
  o: {
    id: string
    lineHeight: number
    width: number
    font?: string
    align?: 'left' | 'center' | 'right'
    tracking?: number
    locale?: string
  },
): TextRun[] => {
  const was = ctx.font
  if (o.font) ctx.font = o.font
  const font = ctx.font
  const k = o.align === 'right' ? 1 : o.align === 'center' ? 0.5 : 0
  const runs: TextRun[] = []
  for (const [i, text] of lines.entries()) {
    if (!text.trim()) continue
    const w = trackedWidth(ctx, text, o.tracking, o.locale)
    const x = origin[0] + (o.width - w) * k
    runs.push({
      id: `${o.id}.${i}`,
      text,
      box: [x, origin[1] + i * o.lineHeight, w, o.lineHeight],
      font,
    })
  }
  ctx.font = was
  return runs
}
