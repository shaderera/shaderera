// Text measured and laid out in a width on a Canvas2D context: the size that fits a width, lines
// wrapped greedily at word boundaries, and a line's width at a tracking. Words come from
// Intl.Segmenter, so text without spaces between words (Thai, Chinese, Japanese) wraps too. No
// hyphenation, bidi or kinsoku. It draws nothing: wrap and trackedWidth measure in the font the
// context already has, and fitWidth puts the font back as it found it.

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
