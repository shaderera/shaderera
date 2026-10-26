# API surface

What each package exports at version 0.2.0, and how stable it is. The shapes themselves are in
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

Pinned by tests: `packages/core/src/api.test.ts` lists every export of each entry,
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
| `exportFrames`, `Sink`, `NotDeterministic` | function, type, class | the frame loop with backpressure for an app with its own encoder; `ahead` keeps several frames rendering at once, written in order; `skip` passes over the frames the sink already holds (a resumed export); a source that fails the determinism re-check throws `NotDeterministic` (its `failures`) |
| `DeterminismReport`, `DeterminismFailure`, `JsonChange`, `PixelDiff` | types | results of the above |

The behaviour in [determinism.md](determinism.md) (frame identity, sequential replay, readiness,
failure, cancellation, pixels) is part of the stable surface, not only the types.

## `@shaderera/core/gpu`: experimental

`readTexture(device, texture, bytesPerTexel?)` and `readBuffer(device, buffer, size?)`: WebGPU
readback with the row padding and staging done right. Optional; a source keeps its own device,
resources and passes. Stable only when consumers outside this repository need it.

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
