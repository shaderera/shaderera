# API surface

What each package exports, and how stable it is. The shapes themselves are in
[protocol.md](protocol.md).

| Package | What |
|---|---|
| `@shaderera/core` | the protocol types and the checks |
| `shaderera` | the CLI (plugins included) and the MCP server |
| `create-shaderera` | `npm create shaderera` makes an empty project |

The three packages share one version and follow 0.x semver: any minor may break, loudly. Each
surface is labelled:

- **stable:** what authors build on; a change is a documented decision with a migration note.
  Breaking is allowed until real external consumers exist, but never silent: an old format is
  refused with a message;
- **experimental:** usable, may change in any release;
- **internal:** for Shaderera's own packages only; no promise.

Pinned by tests: `packages/core/src/api.test.ts` lists every export of each entry and holds the
declarations [below](#the-types-a-film-writes-against) to the exported ones,
`apps/cli/src/exports.test.ts` the `shaderera` package's (none but its package.json),
`apps/cli/src/project/schema.test.ts` holds `shaderera.schema.json` to what the CLI reads, and
`packages/create-shaderera/src/create.test.ts` fails when the empty project imports anything but a
stable entry. Adding or removing an export is therefore a visible change.

## `@shaderera/core`: stable

| Export | Kind | What it is |
|---|---|---|
| every type in `protocol.ts` | types | `Open`, `Host`, `Io`, `Source`, `RenderOptions`, `Frame`, `Layer`, `LayerInfo`, `Depth`, `Json`, `Manifest`, `Requires`, `Variant`, `Preroll`, `CameraCapability`, `Matrices`, `Mat4`, `Vec3`, `Pick`, `AudioClip`, `Pcm`, `Caption`, `CheckpointCapability`, `MountDom`, `DomView`, `DecodedImage`, `Footage`, `Bake`, `Baked`, … |
| `flattenFrame(frame)` | function | a composition flattens what its children return |
| `frameTimes(fps, from, to)`, `frameAt(t, fps)` | functions | one definition of a range's frames (t = i / fps) and of the frame index at t |
| `parseFps(value)` | function | a rate as shaderera.json writes it (`30`, `29.97`, `"24000/1001"`) as an exact fraction `{ fps, num, den }`, or null |
| `sha256(bytes)` | function | the SHA-256 of some bytes as lowercase hex, in the browser and in Node: how an analysis names its source |
| `checkDeterminism`, `diffJson`, `diffPixels` | functions | the checks the CLI runs, for an embedding app's own tests |
| `exportFrames`, `Sink`, `NotDeterministic` | function, type, class | the frame loop with backpressure for an app with its own encoder; `ahead` keeps several frames rendering at once, written in order; `hosts` passes `render` which host a frame goes to, round them, and splits the re-check between them, run at once; `onRecheck` counts the re-check's frames; `sequential` keeps a stepped source's re-check to 8 frames; `skip` passes over the frames the sink already holds (a resumed export); a source that fails the determinism re-check throws `NotDeterministic` (its `failures`) |
| `DeterminismReport`, `DeterminismFailure`, `JsonChange`, `PixelDiff` | types | results of the above |

The behaviour in [determinism.md](determinism.md) (frame identity, sequential replay, readiness,
failure, cancellation, pixels) is part of the stable surface, not only the types.

## The types a film writes against

The shapes an agent writes footage, stills, sound and frames against, as `@shaderera/core`
declares them (comments left out; `protocol.ts` has them). A test holds each declaration here to
the exported one, so they never drift. What each field means is in [protocol.md](protocol.md).

**`Io`**, `host.io`: the host's ports, paths relative to the project root. `image`, `video`,
`cache` and `bake` are optional: check before calling.

```ts
export type Io = {
  read(path: string): Promise<Uint8Array>
  canvas(width: number, height: number): OffscreenCanvas
  font(path: string, family: string): Promise<void>
  image?(path: string, options?: { maxSize?: number }): Promise<DecodedImage>
  video?(path: string, space?: FootageSpace): Promise<Footage>
  cache?(
    key: string,
    inputs: readonly string[],
    make: () => Promise<Uint8Array>,
  ): Promise<Uint8Array>
  bake?(name: string): Promise<Baked>
}
```

**`DecodedImage`**, what `io.image` gives: a PNG or JPEG, rows from the top, straight RGBA, 8 or
16 bits a channel.

```ts
export type DecodedImage = {
  readonly width: number
  readonly height: number
  readonly bits: 8 | 16
  readonly data: Uint8Array | Uint16Array
}
```

**`Footage`**, what `io.video` gives: a video file's frames. `frame(i)` is RGBA bytes
(`width × height × 4`) or, with `{ format: 'yuv420p' }`, the Y'CbCr planes `colour` says how to
read, or with `{ format: 'yuv420p10' }` the same planes at 10 bits, a `Uint16Array`. `bits` is the
file's sample depth. `space` is what the film said the file is when it opened it
(`io.video(path, { transfer, gamut })`), absent when it said nothing; the engine converts
nothing by it, `color-spaces` reads it. `close()` frees the decoder when the clip's shot ends.

```ts
export type Footage = {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly frames: number
  readonly bits: 8 | 10 | 12 | 16
  readonly colour: VideoColour
  readonly space?: FootageSpace
  frame(index: number, options: { format: 'yuv420p10' }): Promise<Uint16Array>
  frame(index: number, options?: { format?: 'rgba' | 'yuv420p' }): Promise<Uint8Array>
  close(): Promise<void>
}

export type VideoColour = {
  readonly matrix: 'bt709' | 'bt601' | 'bt2020nc'
  readonly range: 'limited' | 'full'
  readonly chroma: 'left' | 'center' | 'topleft'
}

export type FootageSpace = {
  readonly transfer?:
    | 'bt709'
    | 'srgb'
    | 'pq'
    | 'hlg'
    | 'slog3'
    | 'logc3'
    | 'logc4'
    | 'vlog'
    | 'clog3'
  readonly gamut?:
    | 'rec709'
    | 'rec2020'
    | 'p3d65'
    | 'sgamut3'
    | 'sgamut3cine'
    | 'awg3'
    | 'awg4'
    | 'vgamut'
    | 'cinemagamut'
}
```

**`videoTexture(device, clip, options?)`**, from `@shaderera/core/gpu`: a clip's frames as an
`rgba8unorm` texture of `host.gpu`, converted from its `yuv420p` planes on the GPU. With
`{ bits: 10 }` it converts the `yuv420p10` planes into an `rgba16float` texture: R'G'B' code
values, 0–1 for the nominal range, superwhites and out-of-gamut values kept, no transfer curve.
The texture `frame(i)` returns is valid until the next `frame()` or `destroy()`: two frames at
once need two helpers.

```ts
export const videoTexture: (
  device: GPUDevice,
  clip: Footage,
  options?: { bits?: 8 | 10 | undefined },
) => { frame: (index: number) => Promise<GPUTexture>; destroy: () => void }
```

**`AudioClip`** and **`Pcm`**, what `audio()` returns: a project file (`src`) or sound made in
code (`pcm`), placed at `at` seconds of the film; `gain` a number or a function of the film's
time.

```ts
export type AudioClip = {
  readonly src?: string
  readonly pcm?: Pcm
  readonly at: number
  readonly from?: number
  readonly to?: number
  readonly gain?: number | ((t: number) => number)
  readonly group?: string
}

export type Pcm = { readonly sampleRate: number; readonly channels: readonly Float32Array[] }
```

**`Frame`** and **`Layer`**, what `render(t)` returns: one layer or a flat stack, bottom first. A
canvas, bitmap or video frame knows its alpha; RGBA bytes or a `GPUTexture` of `host.gpu` at the
frame's size say how theirs is stored.

```ts
export type Frame = Layer | readonly Layer[]

export type Layer =
  | ({ readonly color: OffscreenCanvas | ImageBitmap | VideoFrame } & LayerInfo)
  | ({
      readonly color: Uint8Array | Uint8ClampedArray | GPUTexture
      readonly alpha: 'premultiplied' | 'straight' | 'opaque'
      readonly light?: Light
    } & LayerInfo)

export type LayerInfo = {
  readonly name?: string
  readonly final?: boolean
  readonly depth?: Depth
}
```

## `@shaderera/core/gpu`: experimental

`readTexture(device, texture, bytesPerTexel?)` and `readBuffer(device, buffer, size?)`: WebGPU
readback with the row padding and staging done right. Optional; a source keeps its own device,
resources and passes. Stable only when consumers outside this repository need it.

`videoTexture(device, clip)` ([above](#the-types-a-film-writes-against)) converts in integers, so
every host gives the same bytes ([ADR 0027](adr/0027-video-frames-as-ycbcr.md)).
`yuv420pToRgba(planes, width, height, colour)` is the same conversion on the CPU, its reference.
`yuv420p10ToRgba(planes, width, height, colour)` is the reference at 10 bits
([ADR 0031](adr/0031-footage-at-ten-bits.md)): a `Uint16Array` of half floats, the bits the
`rgba16float` texture holds.

## `@shaderera/core/host`: experimental

What a host needs and both of Shaderera's share (`checkManifest`, `withVariant`, `openSource`,
`seekable`, `over`, `straight`, `matte`, `opaque`, `gpuCompositor`, `yuvFits`, `hdrCompositor`,
`p010Fits`, `finalOnly`, `layerInfo`, `lightChecked`, `rangeOf`, `paramDefaults`, `fullDevice`,
`timecodeOf`, `toSrt`, `toVtt`, …), the float64 references the HDR compositor is held to (`rgb10Reference`,
`p010Reference`, `lightReference`) and the numbers they share with the CLI (`CODE_LIGHT`,
`peakCode`, `whiteOf`), for another host that opens a source the way the CLI does. Usable, and
may change in any release. A participant never imports it: a film builds on `@shaderera/core`.

## `shaderera`: the commands are stable; the modules are internal

- **Stable:** the commands and flags in [cli.md](cli.md) but the plugin ones (below), the MCP
  tool names ([mcp.md](mcp.md)), the files they read (`shaderera.json`, format `manifest/1`,
  described by the `shaderera.schema.json` the package ships; `requirements.json`) and the files
  they write: `versions/` (revisions; jobs `job/3`), `out/`
  (`delivery/1`, `deliveries/1`), and the `--json` envelope (`result/1`). A format change refuses
  the old file with a message to recreate it; there are no readers for old formats.
- **Internal:** every module under `apps/cli/src`. The package exports no JavaScript: its only
  export is `shaderera/package.json`. Its other files (`bin/`, `dist/`, `docs/`, `guides/`,
  `shaderera.schema.json`) are on disk in `node_modules/shaderera/` to read, not to import.

## Plugins: experimental

The plugin commands are part of `shaderera`: `search`, `info`, `add`, `remove` and `publish`, reading
plugins from `--site <origin|url|dir>`, else `SHADERERA_SITE`'s `/r`, else Shaderera's own at
`https://shaderera.com/r`. They, the folder layout and the label (`shaderera.item.json`; a
package plugin: `"shaderera"` in its `package.json`) are in [plugins.md](plugins.md). They may
change in any release.
