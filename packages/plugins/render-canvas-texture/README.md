A Canvas2D canvas, or RGBA bytes, uploaded into a `GPUTexture` of `host.gpu` for your WGSL pass, one texture per size reused on every upload.

```ts
import { createCanvasTexture } from './render/canvas-texture.ts'

// in open
const canvases = createCanvasTexture(host)

// in render(t): draw the canvas, then hand it to your pass
const texture = canvases.upload(canvas)   // or canvases.upload({ data, width, height })
// bind texture.createView() in your pass's bind group

// when the film closes
canvases.dispose()
```

- `upload(source)`: the pixels of a canvas (read with `getImageData`) or of RGBA bytes
  (`{ data, width, height }`, row by row from the top, 4 bytes a pixel) written into a texture at
  their size, and that texture. Each call writes the pixels again.
- The texture is `rgba8unorm` (`CANVAS_TEXTURE_FORMAT`), with `TEXTURE_BINDING`, `COPY_DST` and
  `COPY_SRC`. The bytes go in as they are: display values, straight alpha, as Canvas2D keeps them.
  No colour conversion: decode to linear light in your shader if you need it (`render-srgb`).
- One texture per size, made on the first upload of that size and kept until `dispose()`. The next
  upload of the same size writes over it, so two canvases of one size read in the same pass need
  an uploader each.

It does one job. The bind groups, views and samplers stay in your pass. Mip levels, other formats
and premultiplying are not part of it. Needs WebGPU (`host.gpu`), in the browser or in Node with
`webgpu`.
