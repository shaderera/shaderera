The crop of a still that a frame shows: framed on a box with headroom, and moved between two framings at an even speed, always inside the picture.

```ts
import { moveOf, viewOf } from './motion/ken-burns.ts'
import { progress, smooth } from './motion/eases.ts'

// in render(t): from the whole photo to its cat's head, over 0–4 s
const head = region(cat, 'cat-head-0').box                     // { x, y, width, height }
const p = progress(t, 0, 4, smooth)                             // ease it yourself
const v = moveOf(cat.source, { on: 'full' }, { on: head, fill: 0.4 }, p, W / H)
ctx.drawImage(photo, v.x, v.y, v.width, v.height, 0, 0, W, H)
```

A framing is `{ on, fill, eye, maxWidth, dx, dy }`:
- `on` is a box (`{ x, y, width, height }` in the picture's pixels) or `'full'`, the largest crop of
  the frame's aspect;
- `fill` is the box's share of the frame's height (0.5); on `'full'` it zooms (1 shows it all);
- `eye` is where the box's centre sits, from the frame's top (0.42: headroom above a face);
- `maxWidth` is the box's largest share of the frame's width (0.92): a box wider than that
  widens the view instead of being cut;
- `dx` and `dy` move the view by shares of its width and height.

`viewOf` gives one framing's view; `moveOf` the view at progress `p` between two. The width goes
in log space, so a push reads at the same speed from start to end; the centre goes in a straight
line. A view never leaves the picture: it shrinks to fit, then slides back in, so near an edge the
box sits off its mark.

It gives a rectangle only. Boxes come from `image-regions` or any analyser, and drawing the crop
and easing `p` (`motion-eases`) are the film's. Keeping the view inside the picture is
`image-fit`'s `crop`, which `add` copies in with it.
