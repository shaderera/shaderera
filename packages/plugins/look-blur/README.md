Blur any frame on the GPU, Gaussian, bokeh, directional or radial, by an amount each pixel takes from shapes, a map or depth.

```ts
import { createBlur } from './looks/blur.ts'

// in open
const blur = createBlur(host, { width: W, height: H })

// in render(t): your frame (a GPUTexture of host.gpu, or a Canvas2D canvas), blurred
const color = blur.apply(frame, {
  kind: 'gaussian',                  // 'gaussian' | 'bokeh' | 'directional' | 'radial'
  radius: 80,                        // px a pixel's light reaches at amount 1
  shapes: [{ x: 360, y: 270, w: 150, h: 490, amount: 0 }],   // a sharp window; the rest blurred
})
return [{ color, alpha: 'premultiplied' }]
```

Where it blurs: `amount` (1 by default) everywhere, then each of up to 8 `shapes` painted over it
in order, a rounded box whose inside takes its own `amount` and eases back over `feather` px
outside its edge. A full-width band at 0 with a wide feather is tilt-shift; a box at 1 over an
unblurred frame (`amount: 0`) is a censor box. Then two more amounts multiply in, each optional:
- `map`: a canvas or a texture, its red times its alpha, for any shape you can draw;
- `depth`: a layer's depth (`{ data, focus, range }`, one distance per pixel at the frame's
  size): sharp at `focus`, fully blurred `range` away. This is depth of field for the `focus` a
  `camera-keyframes` shot carries.

The kinds, all reading the same frame:
- `gaussian`: soft, σ half the radius, accurate from a fraction of a pixel to hundreds;
- `bokeh`: a lens's disc, or a polygon with `blades` (5, 6, …) turned by `rotation`. `highlights`
  (4 by default) takes near-white pixels to be brighter than white, so small lights open into
  discs instead of fading to grey;
- `directional`: a smear along `angle` (radians, 0 along the rows), `radius` each way;
- `radial`: a zoom from `centre` (px, the frame's centre by default), `radius` each way at the
  farthest corner and less nearer the centre.

Any radius costs the same: every kind reads a pyramid of the frame made once per call. `taps`
trades smoothness for speed in bokeh, directional and radial. The blur works in linear light, and
a pixel at amount 0 comes back exactly as it went in.

A texture source needs `TEXTURE_BINDING`; say how it stores alpha with `alpha` (premultiplied by
default; a canvas is straight). An `-srgb` texture is read as linear. Needs WebGPU (`host.gpu`), in
the browser or in Node with `webgpu`.

This is a blur of one frame. Motion blur is the picture averaged over several `t` inside a shutter,
which the film does by rendering those `t`; a `directional` smear only looks like it.
