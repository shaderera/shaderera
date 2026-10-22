# Raw WebGPU

A source that uses WebGPU gets a `GPUDevice` as `host.gpu`: the browser's in the runner's Worker,
Dawn's in Node. It returns its output in one of two ways:

- **A texture.** A `GPUTexture` of `host.gpu` at the frame's size, with `TEXTURE_BINDING` in its
  usage, is a layer as it is (`{ color: texture, alpha }`). The host composites on the same device
  with no copy.
- **Bytes.** It copies to a buffer, maps it and returns RGBA bytes, as the transition below does.

## `webgpu` is your project's dependency

```json
"devDependencies": { "shaderera": "...", "vite": "8.3.5", "webgpu": "0.6.2" }
```

The Node host resolves `webgpu` from the project root. If it is installed, the host assigns
Dawn's globals (`GPUBufferUsage`, `GPUTextureUsage`, `GPUMapMode`...), creates one adapter and
device and passes it as `host.gpu`. If not, `gpu` is `undefined`. Shaderera does not depend on it
because it is about 137 MB and most Canvas2D projects do not need it.

0.6.2 is the tested version. It is the first build that ships DXC on Windows (FXC compiled a heavy
compute shader 44–51× slower and could hang the device; node-webgpu PR #20, 2026-09-30) and the
first since 0.4.0 that loads on Ubuntu 22.04 (0.5.0–0.6.1 needed glibc 2.38; PR #21). A new
`webgpu` version can change the shader compiler, so treat it as a change of pixels.

Keep one `webgpu` in the project: the Node host refuses a second `dawn.node` as it loads, and
`shaderera doctor` lists the copies. Give a library the host's device instead of letting it make
its own:

| Library | On `host.gpu` |
|---|---|
| three.js | `new WebGPURenderer({ device })` (see [three.md](three.md)) |
| vgpu | `initFromDevice(host.gpu)` from `vgpu`, not `vgpu/node` (which pins its own `webgpu`); advance its `clock` from `t` |
| TypeGPU | `tgpu.initFromDevice({ device })` |
| Babylon.js | no option to take a device (9.30.0): it makes its own, so its frames come back as bytes |

## A transition is ordinary code

The composition renders both children, uploads their pixels, runs one WGSL pass with progress
from `t`, and returns **one** layer. There is no Shaderera transition type.

```ts
const open: Open = async (host) => {
  const { manifest, io, gpu: device } = host
  if (!device) throw new Error('This transition needs WebGPU (host.gpu).')
  const { width, height } = manifest
  const from = await openTitleCard(host)
  const to = await openGrid(host)

  const decoder = new TextDecoder()
  const code =
    decoder.decode(await io.read('src/vendor/linear-wipe.wgsl')) +
    decoder.decode(await io.read('src/transition.wgsl'))
  const module = device.createShaderModule({ code })
  // ... pipeline, two input textures, an output texture, a uniform buffer,
  //     and a readback buffer with rows padded to 256 bytes
```

```ts
async render(t) {
  upload(fromTexture, await pixelsOf(from, t, width, height))
  upload(toTexture, await pixelsOf(to, t, width, height))
  device.queue.writeBuffer(uniforms, 0,
    new Float32Array([progressAt(t), WIPE.angle, WIPE.feather, width / height]))
  const encoder = device.createCommandEncoder()
  // ... one render pass drawing a fullscreen triangle, then copyTextureToBuffer
  device.queue.submit([encoder.finish()])
  await readback.mapAsync(GPUMapMode.READ)
  const mapped = new Uint8Array(readback.getMappedRange())
  const color = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    color.set(mapped.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4)
  }
  readback.unmap()
  return { color, alpha: 'opaque', name: 'Transition' }
},
async inspect(t) {
  return { id: 'transition', progress: round(progressAt(t)), from: ..., to: ... }
},
```

`pixelsOf` calls `child.render(t, { width, height, intent: 'final' })`, flattens the frame and
reads the canvas's `ImageData`. Remove the row padding when copying out: WebGPU requires
`bytesPerRow` to be a multiple of 256 (`readTexture` in `@shaderera/core/gpu` does both).
Returning the output texture as the layer instead (it needs `TEXTURE_BINDING`) skips the readback
and the padding.

## Vendored WGSL

Core ships no effects. The wipe is LinearWipe from
[shader-effects-inc/shaders](https://github.com/shader-effects-inc/shaders) (MIT), copied into
`src/vendor/linear-wipe.wgsl` with its commit, source paths and licence at the top. Upstream writes
it as TypeGPU functions; the file holds the WGSL they lower to. `src/transition.wgsl` is the
project's own pass around it (vertex `vs`, fragment `fs`). Effects from anywhere join the same
way: copy the WGSL, keep the licence, call it from your pass. shader-effects-inc/shaders has about
200 such effects; its runtime is bound to the DOM, so a film vendors the WGSL body it needs.
