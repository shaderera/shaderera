A vignette over any frame, as one WebGPU pass: the edges towards black or a colour, in linear light, round, the frame's shape or an ellipse of a given size.

```ts
import { createVignette } from './looks/vignette.ts'

// in open
const vignette = createVignette(host, { width: W, height: H })

// in render(t): your finished frame (a GPUTexture of host.gpu, or a Canvas2D canvas), vignetted
const color = vignette.apply(frame, { amount: 0.4, start: 0.35 })
return [{ color, alpha: 'opaque' }]
```

- `amount` (0.4): how far the corners go towards `colour`, 0–1.
- `start` (0.35): where the falloff begins, 0 at the centre and 1 at the corners (or at the edge
  of `size`).
- `roundness` (1): 1 a circle; 0 an ellipse of the frame's proportions, which reaches the long
  sides and the short ones together.
- `centre`: the centre in px, the frame's centre by default.
- `size`: the radii in px of an ellipse the falloff ends at, in place of the frame's corners;
  outside it everything is `amount` of the way, and at [0, 0] it is closed. `roundness` is then
  unused.
- `colour` (black): what the edges go towards, as display values; white for a faded print.

A spotlight is a vignette with a `size`: the picture dims but for a soft ellipse round a box.
Move `centre` and `size` with `motion-keyframes` to carry it from spot to spot, and take
`amount` to 0 to lift it.

```ts
// a box [x, y, w, h] in px, lit with a margin
const spot = vignette.apply(frame, {
  centre: [x + w / 2, y + h / 2],
  size: [w * 0.75 + 60, h * 0.75 + 60],
  amount: 0.95, // in linear light, so white is left at about a quarter
  start: 0.55,
})
```

The mix is in linear light, as a lens loses light, so the falloff keeps its hue. The input is a
finished frame (display values 0–1, alpha ignored); the output is opaque. A source texture needs
`TEXTURE_BINDING`, at the frame's size. Needs WebGPU (`host.gpu`).
