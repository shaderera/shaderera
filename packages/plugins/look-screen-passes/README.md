The frame in another medium, as one WebGPU pass: ascii, halftone, dither, heat, contours, pixels and inverse.

```ts
import { createLooks, LOOKS } from './looks/looks.ts'

// in open (a monospace face registered with host.io.font, for the ASCII glyphs)
const looks = createLooks(host, { width: W, height: H, face: 'IBM Plex Mono' })

// in render(t): your frame (a GPUTexture of host.gpu, or a Canvas2D canvas) in another medium
const color = looks.apply(frame, { look: 'halftone', cell: 12, ink: [0.1, 0.1, 0.1], paper: [0.96, 0.94, 0.9] })
return [{ color, alpha: 'opaque' }]
```

Every look is a parameter set, and the defaults are neutral: white ink on black paper.
- `ascii`: each cell is the glyph of `ramp` (`createLooks`, least ink to most) for the cell's mean
  brightness; `cell` is its width, its height follows the glyphs.
- `halftone`: a dot per cell on a screen turned by `angle` (45°), the dot's area the brightness.
- `dither`: ordered (Bayer 8×8) to `levels` per channel, in `cell`-px blocks.
- `heat`: brightness through `palette` (2–8 colours; a thermal one by default, `HEAT`).
- `contours`: a `line`-px isoline at each of `bands` steps of brightness, over `under` of the frame.
- `pixels`: blocks of `cell` px, each its mean.
- `inverse`: every value turned over.

`ink` and `paper` are the colours ascii, halftone, dither and contours draw with and on; `ink:
'source'` takes the frame's own colour. `gamma` bends the brightness before a look reads it.
`amount` mixes the look over the plain frame, so a look can fade in.

Brightness is Rec. 709 luma of the display values. The input is a finished frame (display values
0–1, alpha ignored): tone-map HDR first. The output is opaque. A source texture needs
`TEXTURE_BINDING`. Needs WebGPU (`host.gpu`), in the browser or in Node with `webgpu`.

Grain, vignette and the row glitch were part of this plugin until 0.2.0; they are now
`look-film-grain`, `look-vignette` and `look-row-glitch`.
