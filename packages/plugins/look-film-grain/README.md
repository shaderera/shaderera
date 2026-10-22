Film grain over any frame, as one WebGPU pass: Gaussian, sized, strongest in the mid-tones, mono or colour.

```ts
import { createGrain } from './looks/grain.ts'

// in open
const grain = createGrain(host, { width: W, height: H })

// in render(t): your finished frame (a GPUTexture of host.gpu, or a Canvas2D canvas), with grain
const color = grain.apply(frame, { amount: 0.04, size: 1.5, seed: options.frame })
return { color, alpha: 'opaque' }
```

- `amount`: the grain's σ in display values (0.04 is 4% of white), the same at any `size`.
- `size`: a grain in px (1.5). At 1 each pixel is its own; larger grains blend smoothly.
- `midtones` (0.7): how much the grain keeps to the mid-tones, as film's does; at 1, pure black
  and white stay clean, at 0 the grain is the same everywhere.
- `color` (0): 0 the same grain on every channel, 1 each channel its own.
- `seed`: the pattern. Pass `options.frame` for grain that lives, a constant for grain that holds.

Put it last, after the looks and the vignette, on the finished frame (display values 0–1, alpha
ignored). The output is opaque.

Return it as one layer, `{ color, alpha: 'opaque' }`. A frame is one layer or a flat
bottom-to-top array of layers, so `[{ color, alpha: 'opaque' }]` renders the same; the array is
for a stack, and the grained frame is already the whole picture. `alpha: 'opaque'` is needed: the
texture says nothing about its alpha. `apply` writes into the same texture on every call. A source texture needs `TEXTURE_BINDING`, at the frame's size.
Needs WebGPU (`host.gpu`), in the browser or in Node with `webgpu`.
