One glyph outline or word morphing into another, letter by letter or as a whole.

```ts
import { lettersOf, morphLetters, morphOf, shapeOf, tracePath } from './type/glyph-morph.ts'
import { loadFont } from './type/outlines.ts'

// in open: shapes and morphs are worked out once
const font = await loadFont(host, 'assets/fonts/IBMPlexSans-Medium.ttf')
const glyph = morphOf(shapeOf(font, 'A'), shapeOf(font, 'g'))
const word = morphLetters(lettersOf(font, 'Shape'), lettersOf(font, 'Morph'))

// in render(t): k runs 0 to 1 (clamped; ease it as the film likes), here from t 1 over 0.6 s
ctx.beginPath()
tracePath(ctx, glyph.at((t - 1) / 0.6).rings, { x: 400, y: 700, size: 500 })
word.forEach((m, i) => {
  // each letter 0.05 s after the one before
  tracePath(ctx, m.at((t - 1 - i * 0.05) / 0.6).rings, { x: 80, y: 900, size: 160 })
})
ctx.fill('nonzero')
```

Units are ems, y up, the pen at 0 and the baseline at 0, as `glyphOutlines` gives them;
`tracePath` places them at `x`, baseline `y` and `size` px per em, y flipped. `shape.rings` are
`Float32Array`s of x, y pairs, every one `points` long (160 by default), to draw however a film
draws: a Canvas2D path, a line strip, points for particles.

How it pairs: contours are resampled evenly by arc length; outers pair with outers and holes with
holes, nearest centroid first; each partner is wound the same way and turned so its points lie
nearest. A contour with no partner grows from, or shrinks to, a point at its centroid, so an "O"
into an "I" closes its hole. `morphLetters` pairs letter i with letter i; the longer word's extra
letters grow from points. Two shapes must have the same `points`. `shapeOf` and `lettersOf` take
`glyphOutlines`' `kerning`, `letterSpacing`, `tolerance` and `variation`, so the same glyph in two
weights of a variable font (`{ wght: 400 }` and `{ wght: 700 }`) morphs too.

`morphOf` does the pairing once; `at(k)` is a lerp, so the same k always gives the same rings.
Pairing is by position and size, not by meaning: a morph between unlike glyphs is a plausible
in-between, not a designed one. Needs `text-glyph-outlines`, which `add` brings with it.
