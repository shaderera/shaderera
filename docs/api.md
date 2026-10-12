# API surface

What each package exports at version 0.1.1, and how stable it is. The shapes themselves are in
[protocol.md](protocol.md).

| Package | What |
|---|---|
| `@shaderera/core` | the protocol types and the checks |
| `shaderera` | the CLI and the MCP server |
| `@shaderera/registry` | search, add, eject, drop and publish catalog items |
| `create-shaderera` | `npm create shaderera` makes an empty project |

The four packages share one version and follow 0.x semver: any minor may break, loudly. Each
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

- **Stable:** the commands and flags in [cli.md](cli.md), the MCP tool names ([mcp.md](mcp.md)),
  the files they read (`shaderera.json`, `requirements.json`, `shaderera.item.json`) and the files
  they write: `versions/` (revisions; jobs `job/3`), `out/` (`delivery/1`, `deliveries/1`), and
  the `--json` envelope (`result/1`). A format change refuses the old file with a message to recreate it; there are no
  readers for old formats.
- **Internal:** every module under `apps/cli/src`. No JavaScript API is exported.

## `@shaderera/registry`: experimental

A registry is a folder of catalog items: extensions, components, presets and media (the package's
own README has the details).

- **The CLI `shaderera-registry`:** `search`, `info`, `grep`, `add`, `eject`, `drop`, `verify`
  and `publish`. `--registry <dir>`, else `SHADERERA_REGISTRY`, else `~/.shaderera/registry`.
- **The label:** `shaderera.item.json` (an extension: `"shaderera"` in its `package.json`) holds
  the item's name, type, category, tags, licence and `requires`; a project's may hold only
  `requires`. It is for finding an item and resolving what it requires; the host never reads it
  to render.
- **The library export:** `assertRequirements`, which `shaderera` calls to refuse a project
  ([cli.md](cli.md#required-items-and-extensions)), and the functions the registry CLI is made of
  (`search`, `add`, `eject`, `drop`, `grep`, `publish`, `resolve`, `checkItem`, …). Internal: no
  promise to other callers.
