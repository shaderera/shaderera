# API surface

What each package exports at version 0.1.2, and how stable it is. The shapes themselves are in
[protocol.md](protocol.md).

| Package | What |
|---|---|
| `@shaderera/core` | the protocol types and the checks |
| `shaderera` | the CLI (add-ons included) and the MCP server |
| `create-shaderera` | `npm create shaderera` makes an empty project |

The three packages share one version and follow 0.x semver: any minor may break, loudly. Each
surface is labelled:

- **stable:** what authors build on; a change is a documented decision with a migration note.
  Breaking is allowed until real external consumers exist, but never silent: an old format is
  refused with a message;
- **experimental:** usable, may change in any release;
- **internal:** for Shaderera's own packages only; no promise.

Pinned by tests: `packages/core/src/api.test.ts` lists every export of each entry, and
`packages/create-shaderera/src/create.test.ts` fails when the empty project imports anything but a
stable entry. Adding or removing an export is therefore a visible change.

## `@shaderera/core`: stable

| Export | Kind | What it is |
|---|---|---|
| every type in `protocol.ts` | types | `Open`, `Host`, `Io`, `Source`, `RenderOptions`, `Frame`, `Layer`, `LayerInfo`, `Depth`, `Json`, `Manifest`, `Variant`, `Preroll`, `CameraCapability`, `Matrices`, `Mat4`, `Vec3`, `Pick`, `AudioClip`, `Pcm`, `Caption`, `CheckpointCapability`, `MountDom`, `DomView`, `DecodedImage`, `Footage`, … |
| `flattenFrame(frame)` | function | a composition flattens what its children return |
| `frameTimes(fps, from, to)`, `frameAt(t, fps)` | functions | one definition of a range's frames (t = i / fps) and of the frame index at t |
| `checkDeterminism`, `diffJson`, `diffPixels` | functions | the checks the CLI runs, for an embedding app's own tests |
| `exportFrames`, `Sink` | function, type | the frame loop with backpressure for an app with its own encoder; `ahead` keeps several frames rendering at once, written in order |
| `DeterminismReport`, `DeterminismFailure`, `JsonChange`, `PixelDiff` | types | results of the above |

The behaviour in [determinism.md](determinism.md) (frame identity, sequential replay, readiness,
failure, cancellation, pixels) is part of the stable surface, not only the types.

## `@shaderera/core/gpu`: experimental

`readTexture(device, texture, bytesPerTexel?)` and `readBuffer(device, buffer, size?)`: WebGPU
readback with the row padding and staging done right. Optional; a source keeps its own device,
resources and passes. Stable only when consumers outside this repository need it.

## `@shaderera/core/host`: internal

What both hosts share (`checkManifest`, `withVariant`, `openSource`, `seekable`, `over`,
`straight`, `matte`, `gpuCompositor`, `yuvFits`, `finalOnly`, `sha256`, `paramDefaults`,
`fullDevice`, `timecodeOf`, `toSrt`, `toVtt`, …). A participant never imports it.

## `shaderera`: the commands are stable; the modules are internal

- **Stable:** the commands and flags in [cli.md](cli.md) but the add-on ones (below), the MCP
  tool names ([mcp.md](mcp.md)), the files they read (`shaderera.json`, `requirements.json`,
  `shaderera.item.json`) and the files they write: `versions/` (revisions; jobs `job/3`), `out/`
  (`delivery/1`, `deliveries/1`), and the `--json` envelope (`result/1`). A format change refuses
  the old file with a message to recreate it; there are no readers for old formats.
- **Internal:** every module under `apps/cli/src`. No JavaScript API is exported.

## Add-ons: experimental

The add-on commands are part of `shaderera`: `search`, `info`, `add`, `remove` and `publish`, with
`--library <dir|url>`, else `SHADERERA_LIBRARY`, else the official catalog at
`https://shaderera.com/r`. They, the library folder and the label (`shaderera.item.json`; a
package add-on: `"shaderera"` in its `package.json`) are in [add-ons.md](add-ons.md). They may
change in any release.
