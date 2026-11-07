A layer over a base by a blend mode, as one WebGPU pass: footage, a render, type, a scanned texture or light, any two pictures of the frame's size.

```ts
import { createBlend } from './composite/blend.ts'

// in open
const blend = createBlend(host, { width: W, height: H })

// in render(t): two pictures (Canvas2D canvases, or textures that say how their alpha is stored)
const color = blend.apply(frame, { color: texture, alpha: 'opaque' }, { mode: 'multiply', amount: 0.6 })
return [{ color, alpha: 'premultiplied' }]
```

- `mode` (required): `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`,
  `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`,
  `saturation`, `color`, `luminosity`, or `add`. There is no default mode and no preset.
- `amount` (1): how much of the layer, 0–1. It scales the layer's alpha, as the spec's opacity
  does, so 0 gives the base back.
- `space` (`'display'`): where the blend is computed. `'display'` is the spec, and what Photoshop
  and Canvas2D's `globalCompositeOperation` do. `'linear'` blends in linear light, so a `screen` or
  an `add` of light adds as light does.

The formulas are those of [W3C Compositing and Blending Level 1](https://www.w3.org/TR/compositing-1/)
to the letter, soft light included (the spec's, not Photoshop's or Pegtop's, which differ
slightly). `add` is not in the spec: it is Photoshop's Linear Dodge, `min(1, Cb + Cs)`. The
pictures combine by the spec's general formula, the blend where both have alpha and source-over
around it, so a layer with holes blends only where it is.

A picture is a canvas (straight alpha, as Canvas2D keeps it), or `{ color, alpha }` as a protocol
layer declares it: a `GPUTexture` of `host.gpu` with `TEXTURE_BINDING`, or a canvas, with
`'premultiplied'`, `'straight'` or `'opaque'`. Both are at the frame's size; another size throws.
A still decoded with `io.image` is drawn into a canvas of the frame's size first (`image-fit`'s
`cover`, or tiled by hand, at any offset): moving that offset every few frames keeps a texture
from looking stuck to the screen.

The input is SDR display values (0–1): tone-map HDR first. The output is premultiplied
`rgba8unorm`, reused on every call. `blendPixel(base, layer, params)` gives one pixel on the CPU
with the same values, and `blendRgb(mode, cb, cs)` the blend function alone. Needs WebGPU
(`host.gpu`). Within one Canvas2D canvas, `globalCompositeOperation` already has these modes
(`lighter` for `add`), so a film drawn only in Canvas2D does not need this plugin.
