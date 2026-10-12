# three.js

Plain three.js with `WebGPURenderer` on the host's `GPUDevice`. Frames go into a `RenderTarget`
and are read back as RGBA bytes, so one code path runs in the browser Worker and in Node.

## Dependencies

```json
"dependencies": { "@shaderera/core": "...", "three": "0.186.1" },
"devDependencies": { "shaderera": "...", "vite": "8.3.0", "webgpu": "0.6.2" }
```

`webgpu` (Dawn) is what gives Node a `host.gpu`; see [webgpu.md](webgpu.md). Without it, throw
in `open` with a message that names what is missing.

## The renderer, on `host.gpu`

```ts
import * as THREE from 'three/webgpu'

const open: Open = async ({ manifest, gpu }) => {
  if (!gpu) throw new Error('This film needs WebGPU: install `webgpu` in Node.')
  const { width, height } = manifest
  // Integration glue: three's animation loop reads `self.requestAnimationFrame`, absent in Node.
  const g = globalThis as { self?: unknown; requestAnimationFrame?: unknown }
  g.self ??= globalThis
  g.requestAnimationFrame ??= () => 0
  // No canvas is ever drawn: frames go to a render target, so a stand-in element is enough.
  const canvas = { width, height, style: {}, addEventListener() {}, removeEventListener() {} }
  const renderer = new THREE.WebGPURenderer({ device: gpu, canvas: canvas as never })
  await renderer.init()
  const target = new THREE.RenderTarget(width, height)
  // ... build the scene ...
```

Those lines of glue (`self`, `requestAnimationFrame`, a stand-in canvas) are what Node needs to
start. Frames are pulled by `t`, but three still runs an internal animation loop: see
[the frame clock](#the-frame-clock) below.

## `render(t)`: place, render, read back

```ts
const place = (t: number) => {
  turntable.rotation.y = spin(t)
  turntable.updateMatrixWorld(true)
  const c = cameraAt(t)
  own.position.set(...c.position)
  own.lookAt(...c.target)
  own.fov = c.fov
  own.updateProjectionMatrix()
  own.updateMatrixWorld(true)
  return overridden ? free : own
}

async render(t) {
  renderer.setRenderTarget(target)
  renderer.render(scene, place(t))
  const color = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)
  return { color: color as Uint8Array, alpha: 'opaque', name: 'Product' }
},
```

Every pose is a function of `t` (`spin(t) = t * 0.6`), never `+= dt`. `alpha: 'opaque'` because
the scene has a background.

## Camera: `get` and `override`

Both cameras use `THREE.WebGPUCoordinateSystem`, so `projectionMatrix` is already in WebGPU clip
space. three's `elements` are column-major, as the protocol wants.

```ts
camera: {
  async get(t) {
    const was = overridden
    overridden = false          // always report the source's own camera
    const c = place(t)
    overridden = was
    return {
      view: [...c.matrixWorldInverse.elements],
      projection: [...c.projectionMatrix.elements],
      up: [0, 1, 0],
      units: 1,
    }
  },
  override(m) {
    overridden = m !== null
    if (!m) return
    free.matrixWorldInverse.fromArray(m.view)
    free.matrixWorld.copy(free.matrixWorldInverse).invert()
    free.matrix.copy(free.matrixWorld)
    free.projectionMatrix.fromArray(m.projection)
    free.projectionMatrixInverse.copy(free.projectionMatrix).invert()
  },
},
```

`free` has `matrixAutoUpdate = matrixWorldAutoUpdate = false`, so three does not overwrite the
matrices it was given. This passes the round-trip rule with a max difference of 0
([protocol.md](../protocol.md#camera)).

## Pick

Mesh names are the part `id`s that `inspect` reports, so a raycast hit is a `Pick`:

```ts
async pick(t, x, y) {
  const ray = new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), place(t))
  const hit = ray.intersectObjects(turntable.children)[0]
  return hit ? { id: hit.object.name, point: hit.point.toArray() } : null
},
```

A scene like this rendered at about 16 ms per frame at 1280×720 in Node (RTX 5070 Ti, D3D12).

## The `render-three-host` registry item

The registry item `render-three-host` (`npx shaderera-registry add render-three-host`) packages a deterministic
three.js setup on `host.gpu` that closes the traps below:

- three's node clock is set to `t`, never the wall clock;
- an output pass applies the tone mapping and the sRGB encoding into the target;
- MSAA is off by default, because MSAA with blending is not deterministic on Dawn/D3D12;
- the frame goes to the host as a `GPUTexture` layer with no copy (`output: 'bytes'` reads it back
  instead).

It works in Node and the browser. Like every added item, its code becomes the project's own.

## Traps

### The frame clock

`WebGPURenderer` keeps a node frame whose id and time advance from its own
`requestAnimationFrame` loop, started by `init()`. Per-frame node updates (light colour and
intensity, passes such as `PassNode`) and caches keyed by the frame id follow it. In a browser
Worker that is wall-clock time, so the same `t` can render differently; in Node the loop never
ticks, so per-frame updates freeze after the first render. One film's browser check differed on 13
of 20 sampled frames until its source stopped the loop and advanced the frame once per render:

```ts
const frameClock = (renderer: THREE.WebGPURenderer) => {
  const r = renderer as unknown as {
    _animation: { stop(): void }
    _nodes: { nodeFrame: { update(): void; time: number; deltaTime: number } }
  }
  r._animation.stop()
  return (t: number) => {
    r._nodes.nodeFrame.update()
    r._nodes.nodeFrame.time = t
    r._nodes.nodeFrame.deltaTime = 0
  }
}
// after `await renderer.init()`: const advance = frameClock(renderer); advance(t) before rendering
```

It reaches into three's internals (three 0.186.1); re-check it when upgrading three.

### Output encoding into a render target

Tone mapping and the sRGB output transform are applied only when the renderer draws to a canvas.
Rendering into a `RenderTarget`, add an output pass (`renderOutput(texture(target.texture), …)`
drawn into an 8-bit target) and check numerically that a linear 0.5 grey reads about 188, not 127.
A `PassNode`-based post-processing chain updates once per animation frame, so with pulled frames it
froze the shot at 2.5 s; a plain output quad does not.

### Readback rows

`readRenderTargetPixelsAsync` returns rows padded to 256 bytes. At 1280 and 1920 px wide the rows
are already multiples of 256; at 1080 px (4320 bytes) they are not, and the image comes back skewed
unless the padding is removed (copy each row out without its padding; review's `readback` check
catches a participant that forgets).

### Multisampling with blending

Blending into a multisampled target was not deterministic on Dawn/D3D12 for one mesh (a
transparent photo reflection: 16 renders of one t gave 2 distinct frames, all identical without
multisampling). Keep `samples: 4` only while `check` passes. For a race like this one, render the
same t several times and compare: over MCP, `render_frame` returns each frame's `sha256`.

### Smaller notes

- `HDRLoader` (or `RGBELoader`) parses `io.read` bytes without a DOM. It imports `three` alongside
  `three/webgpu`; it works in both hosts, but the bundle carries both entry points.
- `PCFSoftShadowMap` is not available in WebGPU; `PCFShadowMap` is used.
- `pick` results with an `id` key are object literals with an `id`, so the stamp gives them a
  `source` (the line in `pick`). It is harmless; MCP takes `source` from `inspect`.

