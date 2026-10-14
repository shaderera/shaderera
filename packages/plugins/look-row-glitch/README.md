Bands of rows thrown sideways, and pixel sorting: runs of pixels sorted by brightness, along rows or columns, on the GPU.

```ts
import { createRowGlitch } from './looks/row-glitch.ts'

// in open
const glitch = createRowGlitch(host, { width: W, height: H })

// in render(t): your frame (a GPUTexture of host.gpu, or a Canvas2D canvas), glitched
const color = glitch.apply(frame, {
  rows: inDrop ? 0.4 : 0,              // the share of bands hit
  shift: 0.15,                         // how far a hit band is thrown, as a share of the row
  sort: 0.5,                           // the share of hit bands that are also pixel sorted
  seed: Math.floor(options.frame / 3), // a new glitch every 3 frames
})
return [{ color, alpha: 'opaque' }]      // the source's alpha: this frame is opaque
```

The frame is cut into bands of rows, `band` px tall (`[4, 48]`, each band one height between). A
hit band is thrown sideways by up to `shift` of the row, wrapping round. A sorted band sorts each
run of pixels whose brightness is within `range` (`[0.25, 1]`), dark to bright or by `order`;
pixels outside the range stay put and end a run. This is the pixel sort Kim Asendorf made known,
done as a stable counting sort over 256 steps of brightness. `axis: 'columns'` sorts down instead.
`rows: 1, shift: 0, sort: 1` is a plain pixel sort of the whole frame.

Pixels move and none is changed, alpha included: return the layer with the source's alpha (a
canvas is straight). The same `seed` gives the same glitch; change it to change the glitch. A
source texture needs `TEXTURE_BINDING`, at the frame's size. Needs WebGPU (`host.gpu`).
