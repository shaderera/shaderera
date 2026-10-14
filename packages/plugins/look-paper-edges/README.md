A print on paper for collage: cut out with a knife or scissors or torn out along any shape, or a strip cut straight or torn, on a paper stock with tone, fibre and a cut face.

```ts
import { cutout, PAPERS, strip } from './looks/paper.ts'

// in open: a figure cut out with scissors, 12 px of paper round it, whiskers and specks left behind
const figure = cutout(host.io, {
  width: w, height: h, alpha, print: (x, y) => rgbAt(x0 + x, y0 + y), scale, seed: 3,
  edge: 'scissors', border: 12, paper: PAPERS.cream, smooth: 3, pieces: 'largest', holes: 'fill',
})

// a strip torn at both ends, cut straight along its length
const band = strip(host.io, {
  width: 900, height: 260, print: (x, y) => rgbAt(x0 + x, y0 + y), scale, seed: 2,
  sides: { left: 'torn', right: 'torn', top: 'cut', bottom: 'cut' },
})

// in render(t): draw a piece at (−margin, −margin) where its raster's (0, 0) belongs
ctx.drawImage(band.canvas, x - band.margin, y - band.margin)
```

A piece is a canvas built once, in `open`, from its seed: the same piece every time. `print` gives
the picture's colour at a raster pixel (straight sRGB), or undefined where there is none, which
leaves bare paper. Lengths are output pixels: `scale` is how many output pixels one raster pixel
becomes, so a piece cut from a 4000 px photo and drawn small still tears at the size asked.

**`cutout`**: `alpha` is the shape's coverage 0–255, `width × height` (a mask from
`image-regions`, a glyph, a star you drew: any shape, holes and separate pieces included). By
default it follows the mask exactly, soft edge, holes and specks as they are. Then, each optional:
- `border` px of piece past the shape, showing bare paper (`around: 'paper'`) or the print going
  on past it (`around: 'print'`, as when cutting loosely round a figure; `print` is then asked for
  pixels outside 0..width and 0..height);
- `edge`: `'cut'`, a knife's smooth curve (the border's width wanders by `wobble` over
  `wavelength` px); `'scissors'`, straight snips meeting at corners, each straying up to `snip` px
  from the outline (more is longer, rougher snips; scissors cannot cut holes, so they are filled,
  and parts about a pixel thin are dropped); or `'torn'`, a tear `depth` px deep with `rim` px
  of white core and `fibre` (narrower than `depth`, the border tears into the shape);
- `pieces`: `'all'`, `'largest'`, or `{ minArea }` px²; `holes`: `'keep'`, `'fill'`, or filled up
  to `{ maxArea }` px²;
- `smooth` px: parts thinner than twice it are cut away (whiskers, hair), and sharper corners
  round off, so keep it small for a star;
- `feather` px: the print fades in from its edge, to lay a piece into a photo unseen.

With a border, the cut is hard inside the paper; with none, it keeps the mask's soft edge.

**`strip`**: each side `'cut'` (straight) or `'torn'`: the tear wanders `depth` px over bends
`wavelength` apart, shows `rim` px of white core beyond the print, and breaks into `fibre` px.

**The paper**, for both: `paper` is the stock's colour (`PAPERS` has white, coated, cream,
newsprint, kraft and black to start from; any `[r, g, b]` will do), `shade` how far its tone
darkens across the sheet (0.06), `grain` its fibre in code values (6), and `edgeShade` how dark
the cut face is at the very edge (0.3). Set the last three to 0 for flat paper. A feathered piece
has no cut face. Both refuse a size that is not a whole number of pixels, an `alpha` of the
wrong length, and an amount that is negative, not a number, or past 1 where it is a fraction.

It draws on the CPU into `host.io.canvas`, so it runs in both hosts with Canvas2D and on the GPU
as an uploaded texture. A large piece costs memory for its distance fields (about 20 bytes a
pixel, 4000 × 4000 is 320 MB); cut from a smaller copy when the frame does not need every pixel.
A tear that moves over time is a new piece per seed; build the ones you need in `open`.
