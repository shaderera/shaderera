Canvas2D text measured and laid out in a width: the size that fits, lines wrapped at word boundaries (Thai too), a line's width at a tracking.

```ts
import { fitSize, fitWidth, trackedWidth, wrap } from './type/fit.ts'

const font = '"IBM Plex Sans"'   // a family alone: fitWidth puts the size in front of it
const size = fitWidth(ctx, font, 'BEAT GRID', W * 0.6)           // the size that sets it this wide
const title = fitSize(ctx, font, 'BEAT GRID', 160, W * 0.6)      // 160, or smaller to fit

ctx.font = `48px ${font}`                                        // wrap and trackedWidth measure in ctx.font
ctx.textAlign = 'left'
for (const [i, line] of wrap(ctx, copy, W * 0.5, { locale: 'th' }).entries())
  ctx.fillText(line, W - 40 - ctx.measureText(line).width, 200 + i * 64)   // set right

const w = trackedWidth(ctx, 'SLOGAN', 12)                       // with 12 px between the letters
```

It measures and draws nothing. `wrap` and `trackedWidth` use the font the context has, so set
`ctx.font` (and draw) as the film likes; `fitWidth` sets the font only to measure, and puts it back.

Words come from `Intl.Segmenter`, so a language without spaces between words wraps: pass
`locale: 'th'` for Thai. A line breaks only between words, and punctuation stays with its word; a
word wider than the width gets a line of its own. No hyphenation, bidi or kinsoku.

`tracking` is px between each pair of characters (graphemes, so a Thai mark stays with its
consonant), the way `ctx.letterSpacing` draws it, less the space after the last.
