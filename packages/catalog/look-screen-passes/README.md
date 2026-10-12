Screen looks over any frame, as one WebGPU pass: ascii, halftone, dither, heat, contours, pixels, inverse, and a row glitch with pixel sorting.

```ts
import { createLooks, LOOKS } from './looks/looks.ts'

// in open (a monospace face registered with host.io.font, for the ASCII glyphs)
const looks = createLooks(host, { width: W, height: H, face: 'IBM Plex Mono' })

// in render(t): your frame (a GPUTexture of host.gpu, or a Canvas2D canvas) in another medium
const k = clock.sixteenthAt(t)
const color = looks.apply(frame, {
  look: LOOKS[1 + (k % 7)],          // a medium a 1/16
  glitch: inDrop ? 0.3 : 0,
  grain: 0.03,
  seed: options.frame,
})
return [{ color, alpha: 'opaque' }]
```

The input is a finished frame (display values 0–1): tone-map HDR first. A source texture needs
`TEXTURE_BINDING`. Needs WebGPU (`host.gpu`), in the browser or in Node with `webgpu`.
