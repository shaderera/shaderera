# The protocol

> Anything that returns the same frame for the same `t` can participate. Everything else it
> exposes (state, depth, camera, picks, sound, source lines) makes the CLI and MCP better, but is
> optional.

Shaderera owns production: timing, determinism, export, variants, review, delivery and revisions.
The project's code owns everything creative: what a frame shows, how it moves, its camera, its
look. There is no scene format, timeline, effect graph or other representation of the film; the
film is its code. Core has no adapter for any technology: a participant lives in the project that
uses it, and becomes an add-on when another film can reuse it as it is. One test keeps the
line: if changing a field could change a rendered frame, it does not belong in the manifest or in
an add-on's label.

The protocol is a set of TypeScript types in `@shaderera/core` (`packages/core/src/protocol.ts`).
A project's entry module default-exports an `Open` (or a `Source` directly). Everything else is
yours.

## `render(t)`

```ts
type Source = {
  render(t: number, options: RenderOptions): Promise<Frame>
  inspect?(t: number): Promise<Json>
  pick?(t: number, x: number, y: number): Promise<Pick | null>
  camera?: CameraCapability
  audio?(): Promise<readonly AudioClip[]>
  captions?(): Promise<readonly Caption[]>
  checkpoint?: CheckpointCapability   // save and restore for a `sequential` source
  dispose?(): void
}

type RenderOptions = {
  width: number
  height: number
  frame: number                 // Math.round(t * fps)
  intent: 'preview' | 'final'   // export and check use 'final'
  signal?: AbortSignal          // aborted when a scrub makes the render stale
  camera?: Matrices
  dom?: ImageBitmap             // the project's DOM at t (`manifest.dom`, browser host only)
}
```

`render` takes the time in seconds, not a cursor. There is no `play()`, `next()` or `seek()`:
the host owns the clock and asks for any `t` in any order. `t` runs from 0 up to, but not
including, `duration`: the last frame is at `duration - 1/fps` (5.9667 s in a 6 s film at
30 fps), so `t = 6` is outside a 6 s film. That is what lets `check` revisit a
frame after a different one, and lets `inspect` answer "what was the state at 4.133 s" without
replaying the film. A source that reads `Date.now()` or `requestAnimationFrame` breaks this. What
a host does frame by frame, and what a source must do in return, is in
[determinism.md](determinism.md).

- The host never overlaps calls on one source, so a stateful renderer (a three.js scene, a DOM
  page) can set itself up for `t` inside `render` without races.
- A newer render makes an older one stale, and a host may abort the older render's `signal`. A
  source may stop early when it sees that (throwing is fine; the host drops that result) or ignore
  it.
- `render(t)` resolves when its frame is ready: there is no separate readiness call.
- `options.camera` asks the source to render through other matrices than its own (see
  [camera](#camera)). `dom` is described in [participants/dom.md](participants/dom.md).

## `Frame` and `Layer`

```ts
type Frame = Layer | readonly Layer[]

type Layer =
  | ({ color: OffscreenCanvas | ImageBitmap | VideoFrame } & LayerInfo)
  | ({
      color: Uint8Array | Uint8ClampedArray | GPUTexture
      alpha: 'premultiplied' | 'straight' | 'opaque'
    } & LayerInfo)

type LayerInfo = { name?: string; final?: boolean; depth?: Depth }
```

A frame is one layer or a **flat** bottom-to-top array. The host composites the stack with
premultiplied source-over (`over`), depth-tested where layers carry `depth`: on the GPU when it
has a `GPUDevice`, on the CPU otherwise. Nesting is rejected by `flattenFrame`:

```
A Frame is one Layer or a flat array of Layers; nesting is not part of the protocol.
```

- **Pixels are at the requested size** (`options.width` × `options.height`).
- **Bytes declare their alpha.** A canvas knows how its alpha is stored; a `Uint8Array` does not.
  three's `readRenderTargetPixelsAsync` gives opaque bytes, Chromium's PNG decoded through a
  canvas gives straight alpha, a WGSL pass may write premultiplied. Saying which avoids a halo or
  a double multiply in `over`.
- **A texture stays on the GPU.** `color` may be a `GPUTexture` of `host.gpu` at the frame's size
  with `TEXTURE_BINDING` in its usage. The host composites it with no copy; an `-srgb` format is
  encoded back to sRGB. It declares its alpha like bytes.
- **`name`** labels the layer, **`final: false`** marks a progressive preview, and **`depth`**
  places its pixels ([below](#progressive-and-depth)). None of these is creative structure.
- In the Node host a layer is a canvas, RGBA bytes or a `GPUTexture`; `ImageBitmap` and
  `VideoFrame` are browser-only.

## `Open`, `Host` and `Io`

```ts
type Open = (host: Host) => Source | Promise<Source>

type Host = {
  manifest: Manifest
  params: { [key: string]: Json }
  seed: number                 // manifest.seed, or 0
  io: Io
  gpu?: GPUDevice              // offered when the host has WebGPU; never required
}

type Io = {
  read(path: string): Promise<Uint8Array>                 // project-relative
  canvas(width: number, height: number): OffscreenCanvas  // OffscreenCanvas / @napi-rs/canvas
  font(path: string, family: string): Promise<void>       // registers a font for the 2D context
  // Both Shaderera hosts provide these (optional for other hosts):
  image?(path: string): Promise<DecodedImage>             // PNG or JPEG, straight RGBA, 8 or 16 bits
  video?(path: string): Promise<Footage>                  // { width, height, fps, frames, frame(i) }
  cache?(key: string, inputs: string[], make: () => Promise<Uint8Array>): Promise<Uint8Array>
}
```

Everything async (fonts, shaders, a renderer's `init()`) happens once, in `open`. `io` is the
narrow port that lets the same code run in a browser Worker and in Node: only the canvas's 2D
context is portable. In Node, `io.read` and `io.font` refuse paths outside the project. A source
that needs something the host lacks (`gpu`, `dom`) checks in `open` and throws a message naming
it, before any frame.

- `io.image` decodes PNG and JPEG in JavaScript (fast-png, jpeg-js) in both hosts, never with a
  canvas or the browser's decoder, so every host gets the same pixels: straight RGBA, the file's
  sRGB code values, 8 bits a channel or 16 for a 16-bit PNG. Once per file in a host. Other formats
  are converted to PNG once (the catalog's `render-image-textures` has the tool).
- `io.video` opens a video file for its frames. The CLI's process decodes it in software with
  ffmpeg (one thread), by the file's own colour tags to full-range RGBA, and hands frame i over;
  frames read in order stream, a frame before the last one restarts the decoder. Which frame a t
  shows is the film's choice (`fps` is the file's). The same frame is the same bytes in both hosts
  (tested against ffmpeg's own decode).
- `io.cache(key, inputs, make)` keeps derived bytes in `.shaderera/cache/` across renders, hosts and
  runs: `make` runs only when nothing is kept for the key with the input files as they are now (a
  changed input is another entry). Put a version in the key when the making changes.
- Project code cannot write files or run programs
  ([where it runs](determinism.md#where-project-code-runs)), so the cache and the decoder run in
  the CLI's process: the Node host asks over IPC, the browser host over the runner server.

## `shaderera.json`

```json
{
  "entry": "./src/composition.ts",
  "fps": 30,
  "duration": 6,
  "width": 960,
  "height": 540
}
```

| Key | Required | Meaning |
|---|---|---|
| `entry` | yes | the module that default-exports the `Open` or `Source` |
| `fps` | yes | a number or a fraction (`"24000/1001"`); 23.976, 29.97 and 59.94 mean their fractions, and the host gives the source that exact number |
| `duration`, `width`, `height` | yes | seconds; integer pixels |
| `params` | no | a JSON Schema (`type: 'object'`) of what the host passes to `open` |
| `seed` | no | the only randomness a source may use |
| `sequential` | no | only `true`: state carries from frame to frame ([determinism.md](determinism.md#pure-and-sequential-sources)) |
| `host` | no | `node` (default) or `browser`: the host every tool opens |
| `dom` | no | a `MountDom` module; needs `"host": "browser"` |
| `domScale` | no | 1–4: pixels per CSS pixel the browser host draws `dom` with |
| `stamp` | no | only `true`: [source stamps](#the-stamp) |
| `variants` | no | named outputs (below) |
| `preroll`, `timecode`, `textless` | no | for a broadcast delivery ([delivery.md](delivery.md#broadcast-preroll-timecode-textless)) |
| `$schema` | no | editor help |

Any other key is an error:

```
shaderera.json: unknown key "scenes"
```

The manifest is metadata that the CLI and MCP read without running code. Nothing about what is
drawn goes in it. An NTSC rate tags the mp4 with its fraction (ffprobe: `30000/1001`), and its
timecode is drop-frame at 29.97 and 59.94.

**Variants** name the outputs the composition is designed for:

```json
"variants": {
  "portrait": { "label": "9:16", "width": 1080, "height": 1920 },
  "short": { "label": "6 s cutdown", "duration": 6, "params": { "cta": "Now" } }
}
```

Each may override `width`, `height`, `duration` and `fps`, set params, and declare `preroll`,
`timecode` and `textless`. A host opens the source with the variant applied to `host.manifest`
and its params over the defaults (`withVariant` in `@shaderera/core/host`); the source lays
itself out from that manifest, so a variant is a designed output, never a crop of another.
Revisions and jobs, which freeze a variant, params and a source for export, live above the
protocol, in the CLI ([cli.md](cli.md#versions-and-jobs)).

## A composition is a source

There is no timeline or scene format. A composition opens its children, calls them with offset
`t`, switches with an `if`, and returns their flattened layers:

```ts
const product = { id: 'shot-product', start: 2 }
const cta = { id: 'shot-cta', start: 7 }

async render(t, o) {
  if (t < product.start) return flattenFrame(await headline.render(t, o))
  const a = flattenFrame(await three.render(t - product.start, o))
  if (t < cta.start) return a
  return [...a, ...flattenFrame(await ctaCard.render(t - cta.start, o))]
},
```

Capabilities delegate the same way: this composition's `camera.get(t)` is
`three.camera.get(t - product.start)`. A transition is also just code: see
[webgpu.md](participants/webgpu.md). Nothing forces 2D and 3D apart: a Canvas2D title, a 3D
product, a WGSL transition, footage and a DOM HUD are one source with five children.

## Capabilities

A source implements `render` and nothing else is required. Each optional member turns on more of
the CLI and MCP. A capability exists when its method exists; there is no flag object that could
disagree with the methods. `sequential` is the one declared property, because "can only step
forward" cannot be seen from a source's shape. A tool reports an absent capability as unknown,
never as a pass.

| Capability | You implement | CLI | MCP |
|---|---|---|---|
| render | `render(t, options)` | `render`, `still`, `check` (pixels) | `render_frame`, `export`, `diff` (pixels) |
| inspect | `inspect(t)` returning JSON | `inspect`, `check` (inspect + pixels), `review` | `inspect`, `diff` (state) |
| `id` / `source` | an `id` on object literals in the inspect JSON; `"stamp": true` for `source` | `source` lines in `inspect` | `get_source`, `pick`'s `source` |
| pick | `pick(t, x, y)` → `{ id, point? }` | — | `pick` |
| camera | `camera.get(t)` → `Matrices`; `camera.override(m \| null)` | — | `get_camera`; `render_frame`'s `camera` |
| audio | `audio()` → `AudioClip[]` | `render` mixes it | `export` |
| captions | `captions()` → `Caption[]` | SRT and WebVTT beside every export | `export` |
| progressive | layers with `final: false` | — | `render_frame` reports `layers[].final` |
| checkpoint | `checkpoint.save()` / `restore(state)` on a `sequential` source | a jump back restores one instead of replaying ([checkpoints](determinism.md#checkpoints)) | the same |
| depth | `layer.depth` | every command depth-tests layers that carry it | every tool |

### inspect, `id` and `source`

`inspect(t)` returns any JSON. The tools show it as a tree and recognise shapes without a schema
(anything with `view` and `projection` matrices is a camera). Two keys mean something on any
object inside it:

- **`id`**: stable across `t`. `pick` returns it, `get_source` finds by it, and `inspect --path`
  addresses arrays by it (`keys[id=k5]`).
- **`source`**: `file:line:col` of the literal. You do not write it: set `"stamp": true` and the
  build stamps it. It means the source literal associated with this object, not the exact line
  responsible for every computed value.

These are conventions on JSON, not an IR. With them an agent finds a camera jump through the
protocol alone ([mcp.md](mcp.md#walk-through-a-camera-jump)).

#### Text runs

Review reads the text a source shows from the inspect JSON. Any object in it, at any depth, with
a string `text` and a `box` of four numbers is one text run:

```ts
{ id: 'headline', text: 'Built for the last mile', box: [160, 220, 1280, 96], font: '96px "Brand Sans"' }
```

- **`box`** is `[x, y, width, height]` in frame pixels, from the top left.
- **`id`** names the run across t. Without one, a run is numbered by its place (`#0`, `#1`),
  which can change from one t to the next.
- **`font`** is a CSS font string or a family name (`family` works too). The `glyphs` check
  looks up the families in it among the fonts loaded through `io.font`.
- **`opacity`** (default 1): `opacity: 0` or `visible: false` means the run is not shown.
  `reading` counts a run as visible from 0.5 up.
- `role` and `size` are optional. Objects inside a run are not searched for more runs.

Anything else is skipped with no warning: `box: { x, y, w, h }`, a box of strings, a `text`
that is not a string. When no run is found, the text checks are unknown with `neither inspect
nor the DOM shows text`; when some are, `text-fit` says how many it read (`3 runs at 41 t`).

### The stamp

With `"stamp": true`, the Node build and the runner run a Vite plugin
(`apps/cli/src/stamp/plugin.ts`, `enforce: 'pre'`). In `.ts .tsx .js .jsx .mts` files under the
project root (not `node_modules` or `.shaderera`), every object literal with a non-computed `id`
key gets one more enumerable key, inserted right after its `{`:

```ts
const title = { id: 'title', x: 160 }
// builds as
const title = { source: "src/composition.ts:16:15", id: 'title', x: 160 }
```

The path is relative to the root with forward slashes; line and column are 1-based and point at
the `{` (oxc-parser offsets count UTF-16 code units, as JavaScript strings do). Spread copies it
(`{ ...title, opacity }` keeps title's source). Objects without `id`, and objects that already
have `source`, are untouched. The plugin returns a hires source map, so stack traces still point
at the original lines. The stamp is opt-in because the extra enumerable key reaches code that
enumerates or hashes those objects. The CLI does not edit code: an agent follows the stamp to the
file and edits it.

### pick

`pick(t, x, y)` gets pixel coordinates in the output frame and returns the `id` of an inspected
object, plus the world `point` if known. A three.js raycast is in
[participants/three.md](participants/three.md#pick).

### camera

```ts
type Matrices = { view: Mat4; projection: Mat4; up?: Vec3; units?: number } // column-major
type CameraCapability = {
  get(t: number): Promise<Matrices>
  override?(matrices: Matrices | null): void   // null gives control back to the source
}
```

Core has no camera model, and the hook is frozen: no lens fields, kinds or multiple cameras. How
a camera moves is the film's code (the catalog has `motion-keyframes`, `camera-keyframes` and
`camera-shake`). The hook covers cameras a 4×4 view and projection describe; a source with
another kind (fisheye, panoramic) or several leaves `camera` out and reports them in `inspect`.

- **Projection is in WebGPU clip space** (z in [0, 1]). In three.js set
  `camera.coordinateSystem = THREE.WebGPUCoordinateSystem`; with wgpu-matrix, `mat4.perspective`
  already is.
- **`units`** is metres per world unit; **`up`** is the world up vector.
- MCP's `get_camera` turns the matrices into eye, forward, up, fovY, aspect, near and far.

**The round-trip rule.** Rendering through the source's own camera must equal overriding with what
it reports:

```
render(t)  ==  override(get(t)); render(t)     (max pixel difference 0)
```

`apps/cli/src/camera/roundtrip.test.ts` enforces this on a three.js source and on a Canvas2D
source with its own matrices, at three times each. So `get` must report the source's own camera
even while an override is active ([three.md](participants/three.md#camera-get-and-override) clears
the flag around `place(t)`), and `override` must apply exactly the matrices, not re-derive them
from a position and fov.

### audio

```ts
async audio() {
  return [{ src: 'src/assets/chime.wav', at: 0.4 }]
}
```

`src` is a project file, `at` is where it starts in composition seconds; `from`/`to` trim the file
and `gain` scales it. The export trims each clip to its window, delays it into place and mixes the
clips without amix's normalisation.

`gain` is a number, or a function of the composition's time, written like `render(t)`:

```ts
// A fade in over the first second, and a duck under the voice from 4 s to 6 s.
const gain = (t: number) => Math.min(1, t) * (t >= 4 && t < 6 ? 0.3 : 1)
audio: async () => [{ src: 'audio/bed.wav', at: 0, gain }]
```

A function cannot cross to the process that mixes, so the host samples it every millisecond over
the composition, and the export interpolates between those samples at 48 kHz. The function must be
pure and return finite numbers; a NaN fails the render with the clip and the time.

`group` names the stem a clip belongs to (`dialogue`, `music`, `fx`; letters, digits, `.`, `_`
and `-`): `render --stems` writes one WAV per group ([delivery.md](delivery.md#stems-and-captions)).

**Sound made in code.** A clip may carry `pcm: { sampleRate, channels }` (one or two
Float32Arrays, values in [-1, 1]) instead of `src`: samples computed in `open` or `audio()`, from
the seed, never a clock. It is mixed exactly as a file clip is (trims, delay, gain, groups,
loudness); tested against the same tone as a WAV file, in both hosts.

```ts
const tone = new Float32Array(48000).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000))
audio: async () => [{ pcm: { sampleRate: 48000, channels: [tone] }, at: 1 }]
```

### captions

```ts
async captions() {
  return [{ start: 0.5, end: 2.4, text: 'Made with code' }]
}
```

Captions in composition seconds; `\n` breaks a line. Every export writes them as SRT and WebVTT
sidecars, cut to its window; they are never drawn into the frame. Burned-in text is the film's own
drawing.

### progressive and depth

- **`final: false`** on a layer says "this is a preview, call me again". Final means converged by
  the source's own definition. Export and `check` always ask with `intent: 'final'`.
- **`depth`** (`{ data: Float32Array, kind: 'view-z' | 'ray-distance', units, soft? }`) is one
  distance per pixel, `Infinity` where the layer is nowhere. The host depth-tests the layers that
  carry it against each other: a nearer opaque pixel hides what comes later behind it, and `soft`
  fades over that many depth units instead of cutting off. So a layer drawn by one renderer can
  stand inside another's scene (text passing behind a product, particles through geometry), when
  both render through one camera (`options.camera`). Layers without depth composite `over` as
  always. Every layer of a frame that carries depth uses the same `kind` and `units`.
- Depth has limits: one depth per pixel per layer; anti-aliased edges, depth of field and motion
  blur have no single depth (`soft` fades instead); the cameras must match exactly; shadows or
  reflections of text on a product need the text as geometry in the renderer that lights it.
  Inside one technology, share the pass instead: Glyph draws into three.js's own pass and depth.

## Not in the protocol

- **A scene graph, layer tree, timeline or keyframe format.** Composition is code; nesting is
  flattened.
- **A camera model.** Cameras cross the boundary as matrices; your rig stays yours.
- **A `composite()` function or blend modes.** The host composites `over` only, depth-tested where
  layers carry depth. Other blends are a source's own WGSL.
- **A clock, `play()` or `seek()`.** The host owns time.
- **Required WebGPU, three.js, React or DOM.** `gpu` is offered, never required; there are no "2D"
  and "3D" modes.
- **Text, shaders, effects, animation or builders** (`scene()`, `mesh()`, `shader()`). Use
  Canvas2D, Glyph, WGSL, GSAP: whatever you already use. Shaderera writes no shaper, renderer,
  muxer or animation engine: encoding is ffmpeg, WebGPU in Node is Dawn.
