A vignette over any frame, as one WebGPU pass: the edges towards black or a colour, in linear light, round or the frame's shape.

```ts
import { createVignette } from './looks/vignette.ts'

// in open
const vignette = createVignette(host, { width: W, height: H })

// in render(t): your finished frame (a GPUTexture of host.gpu, or a Canvas2D canvas), vignetted
const color = vignette.apply(frame, { amount: 0.4, start: 0.35 })
return [{ color, alpha: 'opaque' }]
```

- `amount` (0.4): how far the corners go towards `colour`, 0–1.
- `start` (0.35): where the falloff begins, 0 at the centre and 1 at the corners.
- `roundness` (1): 1 a circle; 0 an ellipse of the frame's proportions, which reaches the long
  sides and the short ones together.
- `centre`: the centre in px, the frame's centre by default.
- `colour` (black): what the edges go towards, as display values; white for a faded print.

The mix is in linear light, as a lens loses light, so the falloff keeps its hue. The input is a
finished frame (display values 0–1, alpha ignored); the output is opaque. A source texture needs
`TEXTURE_BINDING`, at the frame's size. Needs WebGPU (`host.gpu`).
