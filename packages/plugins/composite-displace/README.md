A displacement map, as one WebGPU pass: one picture's channels move another's pixels. A picture seen through ribbed glass or water, type warped by a crumpled paper scan, a heat shimmer from moving noise.

```ts
import { createDisplace } from './composite/displace.ts'

// in open
const displace = createDisplace(host, { width: W, height: H })

// in render(t): the picture to move, and the map that moves it
const color = displace.apply(frame, { color: map, alpha: 'opaque' }, {
  x: { channel: 'red', amount: 20 },
  y: { channel: 'green', amount: 20 },
})
return [{ color, alpha: 'premultiplied' }]
```

- `x`, `y`: per axis, which `channel` of the map moves the source (`red`, `green`, `blue`,
  `alpha`, or `luma`, Rec. 709 of the display values) and the most it moves, `amount` in px. A
  map value of 1 moves the source `amount` px right (down), 0 as far left (up), 0.5 not at all.
  An axis left out does not move; give at least one. A negative `amount` turns the axis over.
- `edges` (`'clamp'`): what shows where a pixel is read from past the frame's edge: the edge pixel
  (`'clamp'`), the other side (`'wrap'`, for a texture that tiles), or nothing (`'transparent'`).

The source is read bilinearly on premultiplied values, so a moved edge has no dark or light halo.
The map's values are its display values as they are: an 8-bit grey of 128 is 0.502, which moves
`amount × 0.004` px. To animate, move the map (draw it at an offset each frame) or change
`amount` over time.

A picture is a canvas (straight alpha, as Canvas2D keeps it), or `{ color, alpha }` as a protocol
layer declares it: a `GPUTexture` of `host.gpu` with `TEXTURE_BINDING`, or a canvas, with
`'premultiplied'`, `'straight'` or `'opaque'`. Both are at the frame's size; another size throws.
A still decoded with `io.image` is drawn into a canvas of the frame's size first (`image-fit`).

The output is premultiplied `rgba8unorm`, reused on every call. Needs WebGPU (`host.gpu`).
