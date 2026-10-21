A still placed into a rectangle of a Canvas2D frame: the decoded image onto a canvas, cover (with a focal point) and contain, and halved copies that draw a large still small with the same pixels whatever was drawn before.

```ts
import { contain, cover, drawFrom, pyramid, toCanvas } from './image/fit.ts'

// in open: decode once, halve once
const photo = pyramid(host.io, toCanvas(host.io, await host.io.image!('assets/photo.jpg')))

// in render(t): fill a box, the crop centred on a point of the photo (image-regions' centre)
const box = { x: 0, y: 0, width: W, height: H }
const f = cover(photo, box, region(cat, 'cat-head-0').centre)
drawFrom(ctx, photo, f.source, f.target)

// or the whole photo inside a card, sitting at its bottom
const g = contain(photo, { x: 80, y: 80, width: 400, height: 600 }, [0.5, 1])
drawFrom(ctx, photo, g.source, g.target)
```

- `toCanvas(io, image)` puts an `io.image` (straight RGBA, 8 or 16 bits) on a canvas of its size.
- `cover(picture, box, focus?)` is the largest crop of the box's aspect, centred on `focus` (in
  the picture's pixels) as near as it can be while inside the picture: near an edge, the focus
  sits off centre. `contain(picture, box, align?)` is the whole picture as large as it fits,
  placed by `align` (`[0, 0]` top left, `[1, 1]` bottom right; centred by default).
- `crop(picture, aspect, focus?, width?)` is the same crop at any width, shrunk to fit and slid
  back in: `camera-ken-burns` moves a view with it.
- A fit is `{ source, target }`, what `drawImage` takes; `ctx.drawImage(canvas, s.x, s.y, s.width,
  s.height, t.x, t.y, t.width, t.height)` draws it without the pyramid.
- `pyramid(io, canvas, smallest?)` keeps the picture and copies halved down to `smallest` px (64)
  on the long side, about a third more memory. `drawFrom(ctx, pyramid, source, target)` draws from
  the level no more than twice the size drawn, with bilinear smoothing, the source kept inside the
  level and the target cut to match, so no pixel is sampled past the picture's edge.

Measured with `@napi-rs/canvas` 1.0.10 on Windows 11: twelve stills up to 8000 px wide, drawn
through `drawFrom` scaled down into 1920×1080 (48 fits: cover, cover on a focus, contain, a small
cover), gave the same bytes in two shuffled orders, with full-size stills drawn at `'high'` in
between. Skia's own `'high'` smoothing was measured the same way in
[determinism.md](https://github.com/shaderera/shaderera/blob/main/docs/determinism.md); the
pyramid is for a still drawn far smaller than it is, which bilinear alone would alias.

It places the picture only: where the box is, how it moves (`camera-ken-burns`) and what the
focus is (`image-regions`) are the film's.
