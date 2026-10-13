3D Gaussian splats from a `.splat` or 3DGS `.ply` file, drawn on the host's GPU with EWA splatting and returned as a layer, the same pixels for the same camera every time.

```ts
import { createSplatRenderer, loadSplats } from './render/splats.ts'

// in open
const splats = createSplatRenderer(host.gpu!, { width: W, height: H })   // format 'rgba16float'
splats.upload(await loadSplats(host, 'assets/garden.ply'))             // or .splat

// in render(t, options): the host's camera when it passes one, else the film's own
const { view, projection } = options.camera ?? myCamera(t)   // column-major Mat4s
return [{ color: splats.render(view, projection), alpha: 'premultiplied' }]
```

The layer is an `rgba16float` texture (or `rgba8unorm` with `format`) at the frame size,
premultiplied alpha, transparent where there are no splats. Colours are as stored in the file
(display values, no conversion, no grading). The texture is reused: composite or read it before
the next `render`. Pass any view and projection in: column-major, the projection in WebGPU clip
space (z 0–1). It needs no other plugin; `camera-keyframes`' `matricesOf(shot, W / H)` gives both.

- Formats: `.splat` (32 bytes a splat) and binary little-endian `.ply` from 3DGS training
  (`parseSplat`, `parsePly`, or `parseSplats`, which reads the header). Splats are plain typed
  arrays: build or edit them in code before `upload`.
- Spherical harmonics degree 0 only: `f_dc` is read, `f_rest` is ignored, so colours do not change
  with the view angle.
- The depth sort runs on the CPU every `render`: a stable radix sort of Float32 view depths, ties in
  splat order, O(N), about 20 ms a frame for 1M splats on a desktop CPU. Splats behind the camera are left out.
- 64 bytes a splat in one storage buffer, up to the device's `maxStorageBufferBindingSize`: the
  Shaderera hosts ask for the adapter's maximum (2 GB, about 33M splats, on an NVIDIA Blackwell),
  WebGPU's default is 128 MiB (about 2.1M); `upload` says so when a file is larger.
- No depth output for the host's depth test: the layer composites `over`.
