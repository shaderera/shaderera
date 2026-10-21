Canvas2D text measured and laid out in a width: the size that fits, lines wrapped at word boundaries (Thai too), a line's width at a tracking, and the lines as the text runs review reads.

```ts
import { fitSize, fitWidth, textRuns, trackedWidth, wrap } from './type/fit.ts'

const font = '"IBM Plex Sans"'   // a family alone: fitWidth puts the size in front of it
const size = fitWidth(ctx, font, 'BEAT GRID', W * 0.6)           // the size that sets it this wide
const title = fitSize(ctx, font, 'BEAT GRID', 160, W * 0.6)      // 160, or smaller to fit

ctx.font = `48px ${font}`                                        // wrap and trackedWidth measure in ctx.font
ctx.textAlign = 'left'
for (const [i, line] of wrap(ctx, copy, W * 0.5, { locale: 'th' }).entries())
  ctx.fillText(line, W - 40 - ctx.measureText(line).width, 200 + i * 64)   // set right

const w = trackedWidth(ctx, 'SLOGAN', 12)                       // with 12 px between the letters
```

Give review the text you set, so its text checks (fit, overlap, glyphs, copy) can read it: wrap,
draw each line where its run's box says, and return the runs from `inspect`.

```ts
ctx.font = `48px ${font}`
ctx.textBaseline = 'top'
const lines = wrap(ctx, copy, 600)
const body = textRuns(ctx, lines, [80, 200], { id: 'body', lineHeight: 64, width: 600, align: 'center' })
for (const r of body) ctx.fillText(r.text, r.box[0], r.box[1])

inspect: (t) => ({ body })                                       // in the source, beside render
```

It measures and draws nothing. `wrap` and `trackedWidth` use the font the context has, so set
`ctx.font` (and draw) as the film likes; `fitWidth` sets the font only to measure, and puts it back.

Words come from `Intl.Segmenter`, so a language without spaces between words wraps: pass
`locale: 'th'` for Thai. A line breaks only between words, and punctuation stays with its word; a
word wider than the width gets a line of its own. No hyphenation, bidi or kinsoku.

`tracking` is px between each pair of characters (graphemes, so a Thai mark stays with its
consonant), the way `ctx.letterSpacing` draws it, less the space after the last.

`textRuns` gives a run a line, in the [shape review reads](https://github.com/shaderera/shaderera/blob/main/docs/protocol.md#text-runs):
`{ id: 'body.0', text, box: [x, y, width, height], font }`. Line i's box is `lineHeight` tall from
`y + i × lineHeight` and as wide as the line measures, placed by `align` in `width`; a blank line
keeps its place and makes no run. Pass `font` to measure in another font than the context's, and
the same `tracking` and `locale` you wrapped with.
