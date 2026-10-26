# Raw WebGPU

A source that uses WebGPU gets a `GPUDevice` as `host.gpu`: the browser's in the runner's Worker,
Dawn's in Node. It returns its output in one of two ways:

- **A texture.** A `GPUTexture` of `host.gpu` at the frame's size, with `TEXTURE_BINDING` in its
  usage, is a layer as it is (`{ color: texture, alpha }`). The host composites on the same device
  with no copy.
- **Bytes.** It copies to a buffer, maps it and returns RGBA bytes. This costs a copy and a wait
  every frame: use it only for a library that cannot draw on `host.gpu`.

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
  // ... pipeline, two input textures, a uniform buffer, and the output:
  const output = device.createTexture({
    size: [width, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
```

```ts
async render(t) {
  await upload(fromTexture, from, t)
  await upload(toTexture, to, t)
  device.queue.writeBuffer(uniforms, 0,
    new Float32Array([progressAt(t), WIPE.angle, WIPE.feather, width / height]))
  const encoder = device.createCommandEncoder()
  // ... one render pass into output.createView(), drawing a fullscreen triangle
  device.queue.submit([encoder.finish()])
  return { color: output, alpha: 'opaque', name: 'Transition' }
},
async inspect(t) {
  return { id: 'transition', progress: round(progressAt(t)), from: ..., to: ... }
},
```

The output texture is the layer: the host composites it on the same device, with no readback.
`upload` puts a child's frame on its texture. A child that returns a `GPUTexture` of the same
device is copied with `copyTextureToTexture`, or bound as it is; a canvas or bytes go up with
`writeTexture` (the `render-canvas-texture` plugin does that). Reading a texture back to bytes, when a test
or a measure needs them, is `readTexture` in `@shaderera/core/gpu`: WebGPU requires
`bytesPerRow` to be a multiple of 256, and it removes the padding.

## Footage and stills

A still or a footage frame is straight RGBA bytes (`io.image`, `io.video`'s `frame(i)`). Write
them to a texture, a still once in `open` and footage once a frame, and sample the texture in a
pass. Fit, scale and blur are then a few lines of WGSL, and the frame never leaves the GPU.

This one pass draws a picture's rectangle over the target. A mip level as small as the target's
pixels scales it down without aliasing; a much smaller level, read with a 3×3 tent, blurs it.

```wgsl
struct U { rect: vec4f, lod: f32, spread: f32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> u: U;

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}

// u.rect is the picture's uv offset and size over the target, read at mip u.lod.
// spread > 0 adds a 3×3 tent of taps that far apart, in texels of that mip: a blur.
@fragment fn fs(v: V) -> @location(0) vec4f {
  let uv = u.rect.xy + v.uv * u.rect.zw;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0); }
  let step = u.spread * exp2(u.lod) / vec2f(textureDimensions(src, 0));
  var c = vec4f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let w = f32((2 - abs(x)) * (2 - abs(y)));
      c += w * textureSampleLevel(src, smp, uv + vec2f(f32(x), f32(y)) * step, u.lod);
    }
  }
  return c / 16.0;
}
```

In `open`, one pipeline, a `pass` that binds one view and draws into another, and a `picture`
that keeps a texture and halves it into its mip levels after each write:

```ts
const { width: W, height: H } = manifest
const format = 'rgba8unorm-srgb' // filtered in linear light, stored as sRGB code values
const module = device.createShaderModule({
  code: new TextDecoder().decode(await io.read('src/media.wgsl')),
})
const over = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } as const
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module, entryPoint: 'vs' },
  fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: over, alpha: over } }] },
})
const sampler = device.createSampler({
  minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear',
})

const pass = (from: GPUTextureView, to: GPUTextureView) => {
  const uniforms = device.createBuffer({
    size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: from },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: uniforms } },
    ],
  })
  return (encoder: GPUCommandEncoder, rect: number[], lod = 0, spread = 0, clear = true) => {
    device.queue.writeBuffer(uniforms, 0, new Float32Array([...rect, lod, spread]))
    const p = encoder.beginRenderPass({
      colorAttachments: [{ view: to, loadOp: clear ? 'clear' : 'load', storeOp: 'store' }],
    })
    p.setPipeline(pipeline)
    p.setBindGroup(0, bindGroup)
    p.draw(3)
    p.end()
  }
}

const picture = (width: number, height: number) => {
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1
  const texture = device.createTexture({
    size: [width, height], format, mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const level = (l: number) => texture.createView({ baseMipLevel: l, mipLevelCount: 1 })
  const halves = Array.from({ length: levels - 1 }, (_, l) => pass(level(l), level(l + 1)))
  return {
    width, height, view: texture.createView(),
    write(encoder: GPUCommandEncoder, data: Uint8Array) {
      device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 4 }, [width, height])
      for (const halve of halves) halve(encoder, [0, 0, 1, 1])
    },
  }
}
```

Cover and contain are a uv rectangle. `scale` below 1 shrinks the picture inside the frame, and
`lod` is the mip level whose pixels are the frame's size:

```ts
const fit = (p: { width: number; height: number }, mode: 'cover' | 'contain', scale = 1) => {
  const r = p.width / p.height / (W / H)
  const sx = (mode === 'cover' ? Math.min(1, 1 / r) : Math.max(1, 1 / r)) / scale
  const sy = (mode === 'cover' ? Math.min(1, r) : Math.max(1, r)) / scale
  const lod = Math.max(0, Math.log2((p.width * sx) / W))
  return { rect: [(1 - sx) / 2, (1 - sy) / 2, sx, sy], lod }
}
```

A blurred backdrop of the footage, and a still contained over it:

```ts
const image = await io.image!('assets/still.png')
if (image.bits !== 8) throw new Error('assets/still.png: an 8-bit PNG or a JPEG')
const clip = await io.video!('assets/clip.mp4')
const still = picture(image.width, image.height)
const footage = picture(clip.width, clip.height)
const output = device.createTexture({
  size: [W, H], format,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
})
const drawFootage = pass(footage.view, output.createView())
const drawStill = pass(still.view, output.createView())
const first = device.createCommandEncoder()
still.write(first, image.data as Uint8Array) // a still: once, in open
device.queue.submit([first.finish()])

return {
  async render(t) {
    const data = await clip.frame(Math.min(clip.frames - 1, Math.floor(t * clip.fps)))
    const encoder = device.createCommandEncoder()
    footage.write(encoder, data) // footage: once a frame
    const back = fit(footage, 'cover')
    drawFootage(encoder, back.rect, back.lod + 5, 1) // a level 32× smaller: a soft blur
    const front = fit(still, 'contain', 0.6)
    drawStill(encoder, front.rect, front.lod, 0, false)
    device.queue.submit([encoder.finish()])
    return { color: output, alpha: 'premultiplied', name: 'Footage and still' }
  },
  // ...
}
```

`lod + 5` reads a level 32 times smaller than the frame's pixels; `+ 4` is a lighter blur. A
cover off centre moves `rect.xy`, kept between 0 and `1 - rect.zw`. This takes 8-bit, opaque
pictures: a still with transparency is premultiplied before it is written, and a 16-bit PNG needs
another texture format.

Measured at 1080p in Node on 4 hosts: a Canvas2D film that put each footage frame on a canvas
and drew it scaled ran at 49 fps on a quiet machine and 22–27 when loaded; the same picture as
textures and one WGSL pass ran at 70 and 48. Drawing an 8000 px still into a 1080p canvas each
frame cost 10–24 ms (21–51 ms with `'high'` smoothing); written once as a texture, it costs
nothing a frame.

## Vendored WGSL

Core ships no effects. The wipe is LinearWipe from
[shader-effects-inc/shaders](https://github.com/shader-effects-inc/shaders) (MIT), copied into
`src/vendor/linear-wipe.wgsl` with its commit, source paths and licence at the top. Upstream writes
it as TypeGPU functions; the file holds the WGSL they lower to. `src/transition.wgsl` is the
project's own pass around it (vertex `vs`, fragment `fs`). Effects from anywhere join the same
way: copy the WGSL, keep the licence, call it from your pass. shader-effects-inc/shaders has about
200 such effects; its runtime is bound to the DOM, so a film vendors the WGSL body it needs.
