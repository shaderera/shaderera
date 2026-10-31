# The protocol

> Anything that returns the same frame for the same `t` can participate. Everything else it
> exposes (state, depth, camera, picks, sound, source lines) makes the CLI and MCP better, but is
> optional.

Shaderera owns production: timing, determinism, export, variants, review, delivery and revisions.
The project's code owns everything creative: what a frame shows, how it moves, its camera, its
look. There is no scene format, timeline, effect graph or other representation of the film; the
film is its code. Core has no adapter for any technology: a participant lives in the project that
uses it, and becomes a plugin when another film can reuse it as it is. One test keeps the
line: if changing a field could change a rendered frame, it does not belong in the manifest or in
a plugin's label.

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
      light?: Light            // an HDR layer: a GPUTexture of rgba16float or rgba32float
    } & LayerInfo)

type LayerInfo = { name?: string; final?: boolean; depth?: Depth }
type Light = { transfer: 'linear' | 'pq'; primaries: 'bt709' | 'bt2020' }
```

A frame is one layer or a **flat** bottom-to-top array. The host composites the stack with
premultiplied source-over (`over`), depth-tested where layers carry `depth`: on the GPU when it
has a `GPUDevice`, on the CPU otherwise. Nesting is rejected by `flattenFrame`:

```
A Frame is one Layer or a flat array of Layers; nesting is not part of the protocol.
```

- **Pixels are at the requested size** (`options.width` × `options.height`), which is
  `host.manifest`'s: a variant or a [draft](cli.md#a-draft) opens the source at another size than
  shaderera.json's. Bytes or a texture at another size are an error, and so is a canvas in the
  Node host when a draft or review's readback opened the source at another size.
- **Bytes declare their alpha.** A canvas knows how its alpha is stored; a `Uint8Array` does not.
  three's `readRenderTargetPixelsAsync` gives opaque bytes, Chromium's PNG decoded through a
  canvas gives straight alpha, a WGSL pass may write premultiplied. Saying which avoids a halo or
  a double multiply in `over`.
- **A texture stays on the GPU.** `color` may be a `GPUTexture` of `host.gpu` at the frame's size
  with `TEXTURE_BINDING` in its usage. The host composites it with no copy; an `-srgb` format is
  encoded back to sRGB. It declares its alpha like bytes.
- **A layer is SDR unless it declares `light`**: sRGB code values, whatever its format. Only in a
  film with [`hdr10`](#hdr10) may an `rgba16float` or `rgba32float` texture declare the light it
  carries: `linear` is BT.2100's FP16 scale (1.0 is 203 cd/m²), `pq` is PQ code values from 0 to
  1, in BT.709 or BT.2020 primaries. A `light` on any other layer is an error, and so is one in an
  SDR render (`host.range` is `sdr`), naming the layer: the film maps its own light down to SDR
  there, with its own code or the `look-tonemap` plugin, and the host never clamps it.
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
  variant?: string             // the variant opened (`9:16`); undefined for the manifest's own output
  range: 'sdr' | 'hdr10'       // the job's: sdr unless it asks for hdr10
  io: Io
  gpu?: GPUDevice              // offered when the host has WebGPU; required for hdr10
}

type Io = {
  read(path: string): Promise<Uint8Array>                 // project-relative
  canvas(width: number, height: number): OffscreenCanvas  // OffscreenCanvas / @napi-rs/canvas
  font(path: string, family: string): Promise<void>       // registers a font for the 2D context
  // Both Shaderera hosts provide these (optional for other hosts):
  image?(path: string, options?: { maxSize?: number }): Promise<DecodedImage> // PNG or JPEG, straight RGBA, 8 or 16 bits
  video?(path: string): Promise<Footage>                  // { width, height, fps, frames, bits, colour, frame(i, { format }), close() }
  cache?(key: string, inputs: string[], make: () => Promise<Uint8Array>): Promise<Uint8Array>
  bake?(name: string): Promise<Baked>                     // { frames, read(i), image(i) }
}
```

Everything async (fonts, shaders, a renderer's `init()`) happens once, in `open`. `io` is the
narrow port that lets the same code run in a browser Worker and in Node: only the canvas's 2D
context is portable. In Node, `io.read` and `io.font` refuse paths outside the project. A source
that needs something the host lacks (`gpu`, `dom`) checks in `open` and throws a message naming
it, before any frame.

- `io.image(path, { maxSize })` decodes PNG and JPEG with one WASM module (zune-png, zune-jpeg;
  [ADR 0028](adr/0028-stills-decoded-once-in-the-cli.md)), in place of fast-png and jpeg-js, never
  with a canvas or the browser's decoder, so every host gets the same pixels: straight RGBA, the
  file's sRGB code values, 8 bits a channel or 16 for a 16-bit PNG. A JPEG's chroma is smoothed as
  libjpeg does by default, and a PNG's `tRNS` chunk gives it its transparency. `maxSize` (whole
  pixels) shrinks the long side to it and the short side to `max(1, round(short × maxSize /
  long))`, with an area-average (box) filter weighted by alpha, in integers, rows then columns, each
  pass rounding half up; where the alpha is 0 the colour is 0. A still within `maxSize` keeps its
  size and bytes. Pass the largest size the film shows the still. The CLI's process decodes a
  still, in a thread of its own, once a command for every host: hosts asking at once share the
  decode, and it is kept in memory until the last of them closes. The decoded bytes are kept in
  the cache (`io.cache`'s, below), keyed by the decoder's version, the file's content hash and the
  decoded width, height and bits, so the next command reads them instead of decoding (a changed
  file is another entry). A still larger than an eighth of the cache's limit is neither kept nor
  decoded there: each host decodes it itself, with the same module. The web player's worker decodes from `files/` with the same module, so the same bytes. Other formats
  are converted to PNG once (the plugin `image-to-png`).
- `io.video` opens a video file for its frames. The CLI's process decodes it in software with ffmpeg
  (one thread), by the file's own colour tags to full-range RGBA, and hands frame i over; frames
  read in order stream. A frame far from the one before (a jump back, a chunk's first frame) starts
  the decoder (on four threads) at the keyframe before it, not at frame 0, when the file's packets
  say which frame is which (H.264, HEVC, ProRes, DNxHD, MJPEG); each frame is checked by its
  timestamp, and any other file, or a frame that does not check, decodes from frame 0 as before. One
  decoder serves every Node host of a render: a frame is decoded once, however many hosts there are,
  and the last few decoded (two a host and one) are kept, so a frame asked a little out of order is
  not decoded again; one before them restarts the decoder. Which frame a t shows is the film's
  choice (`fps` is the file's). The same frame is the same bytes in both hosts (tested against
  ffmpeg's own decode). In a draft render ([`render --draft`](cli.md#a-draft)), whose frame is
  smaller than the film's, the decoder scales the frames by as much each side, and `width` and
  `height` say so. A clip's decoder lives until the render ends unless `close()` stops it and
  frees its buffers, once every host that opened it closed it: a film with many clips closes each
  when its shot ends. A `frame(i)` after `close()` opens the file again and gives the same bytes.
- `io.video`'s `frame(i, { format: 'yuv420p' })` ([ADR 0027](adr/0027-video-frames-as-ycbcr.md))
  hands frame i over as the file's Y'CbCr planes, 1.5 bytes a pixel against RGBA's 4: I420, the Y
  plane then Cb then Cr, rows from the top with no padding, Y `width × height` bytes and Cb and Cr
  each `ceil(width / 2) × ceil(height / 2)`. ffmpeg keeps the file's matrix and range and changes
  only the pixel format: an 8-bit 4:2:0 file (H.264, HEVC) passes through unconverted, a 4:2:2 or
  4:4:4 file is subsampled (its chroma then sited left) and a 10- or 12-bit file reduced to 8 bits.
  `colour` says how to read the planes: `matrix` (`bt709`, `bt601`, `bt2020nc`), `range`
  (`limited`, `full`) and `chroma` siting (`left`, `center`, `topleft`), always resolved: an
  untagged file is BT.601 limited (full for `yuvj` formats), as the RGBA path's conversion takes it,
  and an untagged 4:2:0 file's chroma is the codec's default (left; center for MJPEG). A clip whose
  pixel format has alpha refuses `yuv420p`, naming `rgba`. A clip's decoder serves one format: a
  film that asks for both runs two. With no option, or `{ format: 'rgba' }`, `frame(i)` is the
  RGBA it always was. `videoTexture` in `@shaderera/core/gpu` converts the planes on the GPU, in
  integers, the same bytes in every host and as `yuv420pToRgba` (its TypeScript reference); its
  bytes are close to the RGBA path's (about 34 dB PSNR on a test pattern), not equal: swscale
  takes a 2×2 block's chroma as it is. Another host that offers `io.video` and cannot give planes
  throws a message naming the format.
- `frame(i, { format: 'yuv420p10' })` ([ADR 0031](adr/0031-footage-at-ten-bits.md)) is the same
  planes at 10 bits, a `Uint16Array` of `width × height + 2 × cw × ch` samples (16-bit, the
  10-bit value in the low bits, as ffmpeg's `yuv420p10le`). ffmpeg keeps the file's matrix and
  range and changes only the pixel format: a 10-bit 4:2:0 file passes through as its own
  samples, a 12-bit file is reduced to 10 (swscale dithers), a 4:2:2 or 4:4:4 file is subsampled
  as above, and an 8-bit limited-range file is shifted up two bits (a full-range one is scaled to
  0–1023, its top two bits repeated below). A clip with alpha refuses it, naming `rgba`. `bits` (`8 | 10 | 12 | 16`) is the file's
  sample depth, from its pixel format. `videoTexture(device, clip, { bits: 10 })` converts these
  planes into an `rgba16float` texture: R'G'B' code values, 0–1 for the nominal range, superwhites
  and out-of-gamut values kept (clamped only past ±2), no transfer curve, each value an integer
  k / 1024 so every host stores the same bits as `yuv420p10ToRgba`.
- `io.cache(key, inputs, make)` keeps derived bytes in `.shaderera/cache/` across renders, hosts and
  runs: `make` runs only when nothing is kept for the key with the input files as they are now (a
  changed input is another entry). Put a version in the key when the making changes. The cache
  holds at most 1 GiB (`SHADERERA_FILM_CACHE_MB` sets another limit, in megabytes): a put past it
  removes the least recently used entries (a hit counts as a use) until the rest fit, never the one
  just put, nor a file another host is still writing. An entry removed is made again the next time
  it is asked for, so deleting `.shaderera/cache/` is always safe. The cache also holds the decoded
  stills of `io.image`, under the same limit.
- `io.bake(name)` opens a [bake](#bakes)'s frames: `frames` is their count, `read(i)` frame i's
  bytes as the file has them, `image(i)` the same decoded as `io.image` decodes (PNG, JPEG). The
  frames were checked against the bake's stamp before the source opened.
- Project code cannot write files or run programs
  ([where it runs](determinism.md#where-project-code-runs)), so the cache, the image and video
  decoders and the bake's frames run in the CLI's process: the Node host asks over IPC, the browser host over the
  runner server. A [web player](player.md) has no CLI behind it: its worker answers them itself,
  from the film's files, a video proxy and the bake's frames built with it, and keeps the cache in
  memory.

## `shaderera.json`

```json
{
  "$schema": "./node_modules/shaderera/shaderera.schema.json",
  "shaderera": "manifest/1",
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
| `duration`, `width`, `height` | yes | seconds, a whole number of frames at `fps` (110.62 at 25 fps is refused: use 110.6 or 110.64); integer pixels |
| `params` | no | a JSON Schema (`type: 'object'`) of what the host passes to `open` |
| `seed` | no | the only randomness a source may use |
| `sequential` | no | `true`: state carries from frame to frame; or a whole number, the [lookback](determinism.md#lookback) in frames ([determinism.md](determinism.md#pure-and-sequential-sources)) |
| `host` | no | `node` (default) or `browser`: the host every tool opens |
| `dom` | no | a `MountDom` module; needs `"host": "browser"` |
| `domScale` | no | 1–4: pixels per CSS pixel the browser host draws `dom` with |
| `stamp` | no | only `true`: [source stamps](#the-stamp) |
| `variants` | no | named outputs (below) |
| `preroll`, `timecode`, `textless` | no | for a broadcast delivery ([delivery.md](delivery.md#broadcast-preroll-timecode-textless)) |
| `bakes` | no | frames made outside the host, by name ([below](#bakes)) |
| `requires` | no | what the project needs installed: a `shaderera` range and `extensions`, package plugins by name with a range ([plugins.md](plugins.md#the-one-hard-rule)) |
| `hdr10` | no | the film opts into HDR10 ([below](#hdr10)) |
| `shaderera` | no | the format, `"manifest/1"`; a file without it is that format too |
| `$schema` | no | editor help: `./node_modules/shaderera/shaderera.schema.json`, the JSON Schema the `shaderera` package ships |

Any other key is an error:

```
shaderera.json: unknown key "scenes"
```

So is another format: when the format changes, the old file is refused with a message, never read
wrongly. A new project writes `shaderera` and `$schema`; the schema is editor help, and the host's
own check (every problem, listed) is what decides.

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

Each may override `width`, `height`, `duration` (whole frames at the variant's `fps`) and `fps`, set params, and declare `preroll`,
`timecode` and `textless`. A host opens the source with the variant applied to `host.manifest`
and its params over the defaults (`withVariant` in `@shaderera/core/host`), and gives its name as
`host.variant` (`undefined` for the manifest's own output; a `dom` module gets it too). Every
host does, in every command: the Node host, the browser host and the web player. The source lays
itself out from that manifest and that name, so a variant is a designed output, never a crop of
another:

```ts
const open: Open = ({ io, manifest, variant }) => {
  const stacked = variant === '9:16' // the word over the picture; side by side otherwise
  const canvas = io.canvas(manifest.width, manifest.height)
  // ...
}
```
Revisions and jobs, which freeze a variant, params and a source for export, live above the
protocol, in the CLI ([cli.md](cli.md#versions-and-jobs)).

### HDR10

```json
"hdr10": {
  "graphicsWhite": 203,
  "mastering": { "peak": 1000, "min": 0.0001, "primaries": "p3-d65" },
  "dither": "tpdf"
}
```

A film opts into HDR10 with this block; without it every render is SDR, as before. A job may then
ask for `range: "hdr10"`, and the source reads it as `host.range`. The film's SDR version is a
second render with `range: "sdr"`, where the film maps its own light down. Only a value a standard
names has a default:

- `graphicsWhite`, in cd/m²: where an SDR layer's white goes in an HDR frame. 203 when absent,
  BT.2408's Graphics White.
- `mastering`, required: the display the film was graded on (SMPTE ST 2086): `peak` and `min` in
  cd/m², `primaries` `p3-d65`, `bt2020` or `bt709`. The standard describes a display but names
  none, and only the person knows which one they graded on. A common one is P3-D65 at 1000 cd/m².
- `dither`, required: `tpdf` or `none`, before the 10-bit quantisation. No standard names one.

An `hdr10` render needs a `GPUDevice` in every host: the Node host without the project's `webgpu`
composites with Skia, in SDR only, and refuses it.

```
shaderera.json: hdr10.mastering is required: the display the film was graded on, { peak, min, primaries } (SMPTE ST 2086 describes one but names none; P3-D65 at 1000 cd/m² is common)
```

### Bakes

A **bake** is frames a film reads that were made outside the host, by a program the host cannot
start: a path tracer with a native denoiser that keeps history, a simulation, an offline
render. The manifest declares how they are made, and from what:

```json
"bakes": {
  "beauty": {
    "command": "python tools/trace.py",
    "inputs": ["tools/trace.py", "scene/"],
    "dir": "D:/beauty",
    "frames": "beauty.####.jpg"
  }
}
```

| Key | Meaning |
|---|---|
| `command` | what makes the frames, run by `shaderera bake` in the project folder with the person's rights (the same trust as an npm script); a render never runs it |
| `inputs` | the project files and folders the frames derive from, as a revision lists them: a folder is every file under it except what a revision leaves out (`node_modules`, `out/`, `versions/`); `.` is the whole project |
| `dir` | where the command writes them: outside the project (relative to it, or an absolute path on another drive), or under `out/`. Anywhere else in the project, the frames would be saved into every revision |
| `frames` | their names, one run of `#` for the frame number: `beauty.####.jpg` is `beauty.0000.jpg`, `beauty.0001.jpg`… from 0, without a gap |

`shaderera bake <name>` removes the frames an earlier run left (the files `frames` names in
`dir`), runs the command, and when it exits 0 stamps what it made in
`versions/bakes/<name>.json`: the inputs' hash, and every frame's size and hash. Every command
that renders (`check`, `inspect`, `still`, `render`, `review`) checks each bake against its
stamp first and refuses one that was never made, was declared differently, has an input that
changed, or has a frame missing or changed, naming the bake and `shaderera bake <name>`. There is
no fallback to the old frames (decision 0016). Shaderera never knows what the command does, only
that the frames derive from those inputs. The source reads the frames through `io.bake(name)`;
the bake's folder is readable that way only, and `io.read` still refuses anything outside the
project.

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
| render | `render(t, options)` | `render`, `still`, `check` (pixels) | `render_frame`, `still`, `render`, `compare` (pixels) |
| inspect | `inspect(t)` returning JSON | `inspect`, `check` (inspect + pixels), `review` | `inspect`, `compare` (state) |
| `id` / `source` | an `id` on object literals in the inspect JSON; `"stamp": true` for `source` | `source` lines in `inspect` | `get_source`, `pick`'s `source` |
| pick | `pick(t, x, y)` → `{ id, point? }` | — | `pick` |
| camera | `camera.get(t)` → `Matrices`; `camera.override(m \| null)` | — | `get_camera`; `render_frame`'s `camera` |
| audio | `audio()` → `AudioClip[]` | `render` mixes it | `render` |
| captions | `captions()` → `Caption[]` | SRT and WebVTT beside every export | `render` |
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

With `"stamp": true`, the Node build and the runner run a Vite plugin (`enforce: 'pre'`). In
`.ts .tsx .js .jsx .mts` files under the project root (not `node_modules` or `.shaderera`), every
object literal with a non-computed `id` key gets one more enumerable key, inserted right after its
`{`:

```ts
const title = { id: 'title', x: 160 }
// builds as
const title = { source: "src/composition.ts:16:15", id: 'title', x: 160 }
```

The path is relative to the root with forward slashes; line and column are 1-based and point at
the `{` (oxc-parser offsets count UTF-16 code units, as JavaScript strings do). Spread copies it
(`{ ...title, opacity }` keeps title's source). Objects without `id`, and objects that already
have `source`, are untouched. The Vite plugin returns a hires source map, so stack traces still point
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
a camera moves is the film's code (see the plugins `motion-keyframes`, `camera-keyframes` and
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
clips without amix's normalisation. A `src` with no audio stream (a video without sound) is
silence: the export leaves it out of the mix, as shaderera.com's player does. A `src` that cannot
be read fails the export, naming the clip and its `src`.

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

pcm is uncompressed: 48000 samples × 4 bytes × 2 channels is 384 kB a second, 23 MB a minute,
and about 295 MB for a 13-minute stereo bed. The hosts pass it on as bytes, not text, but it is
held in memory several times on its way (the film's arrays, the copy sent to the page or the
host, the mix), and the studio page and shaderera.com mix it on the viewer's machine. For a long
bed, a minute or more, render it once to a compressed project file (an `.m4a` or `.mp3`) and
return `{ src: 'audio/bed.m4a', at: 0 }` instead: a file clip is read where it is mixed and is a
few MB. Keep `pcm` for short sounds made from the seed, such as hits and stingers.

### captions

```ts
async captions() {
  return [{ start: 0.5, end: 2.4, text: 'Made with code' }]
}
```

Captions in composition seconds; `\n` breaks a line. Every export writes them as SRT and WebVTT
sidecars, cut to its window; they are never drawn into the frame. Burned-in text is the film's own
drawing.

Each caption needs a finite start before its end. Cues read with `text-timed-cues` are captions as
they are, once an LRC's last line, which ends at `Infinity`, is ended with the film; its README
shows how. Review measures the captions against the limits requirements.json declares
([delivery.md](delivery.md#stems-and-captions)).

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
