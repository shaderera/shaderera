# Authoring a Shaderera film

For the person and the agent making or revising a film in this project (Shaderera 0.1.7). The
project is ordinary code: `render(t)` in `src/`, metadata in `shaderera.json`, and this project's
ids, params and requirements in its `README.md`. There is no scene format to fill in: the film is
the source. The reference is in `node_modules/shaderera/docs/` (below, `docs/`: the protocol,
determinism, the CLI, MCP, delivery, and `participants/` per renderer); the task checklists are in
`guides/`.

## The loop

1. **Read the brief and keep what it fixes.** Copy, duration, aspect ratio, brand colours, fonts,
   the real product, the renderer and any expert value ("70 mm", "title at 2.4 s") override every
   default here. Ask only for an input whose absence blocks the result, such as the product's
   model or photographs.
2. **Write the source the brief needs.** The project starts empty: `render(t)` in TypeScript,
   WGSL or any library the film calls for. How it looks comes from the brief and the person,
   never from a default of the engine.
3. **Resolve the assets.** Use the real model, images and fonts, with their licences recorded in
   `ASSETS.md` (source, licence, sha256). If the product is missing, say so and stop or design an
   original object openly. Never present a primitive placeholder as the product. Use footage,
   pictures or sounds from outside sources only when the brief or the person asks
   (`guides/footage.md`, `guides/audio.md`).
   A new project has no font: use the brand's font files from the person, otherwise ask (the
   order, and how `io.font` loads one, are in `guides/typography.md`).
4. **Write the direction down** in `DIRECTION.md`, in whatever form the film needs: it guides the
   work, and nothing parses it.
5. **Look early and often:** `npx shaderera still <t>... --sheet`, or MCP's `render_frame` with
   `image: true`.
6. **Revise narrowly** (`guides/revisions.md`), then **verify**: `npx shaderera check`, review
   (`guides/review.md`), then export. Export refuses a source whose frames change with history.

## Renderers and hosts

A frame is one layer or a stack of them: a canvas, RGBA bytes, or a `GPUTexture` of `host.gpu`
(composited with no copy). Anything that can produce one of those can draw the film, in any mix.

| Renderer | Hosts | Notes |
|---|---|---|
| WebGPU (WGSL) on `host.gpu` | Node (the project's `webgpu` package, Dawn) and the browser | the device is the source's own; return the frame as a texture (`docs/participants/webgpu.md`) |
| three.js `WebGPURenderer` | both | on `host.gpu`, with its frame clock advanced by `t`; the `render-three-host` plugin does this plumbing (`docs/participants/three.md`) |
| Canvas2D | both | `io.canvas`; text through `io.font`, loaded in `open` (`docs/participants/canvas.md`) |
| HTML, CSS, React, GSAP | browser host only | name a `MountDom` module in `shaderera.json` `"dom"`, set `"host": "browser"`, and use `options.dom` as a layer or a texture (`docs/participants/dom.md`) |
| Images, footage, sound made in code | both | `io.image`, `io.video`, `AudioClip.pcm` (`docs/protocol.md`); a film with many clips calls a clip's `close()` when its shot ends, or each decoder holds memory to the end of the render; analysis by a model is decoded once to project files (`docs/analysis.md`) |

## Plugins

Plugins are code that earlier films proved. What you add is copied into the project and is its
own code from then on. The `shaderera-plugins` skill says how to search and add, and how to
recover when a `shaderera` command refuses a project whose `shaderera.json` requires a
package plugin that is not installed. The Claude Code plugin installs it in Claude Code, and
`npx skills add shaderera/shaderera` in other agents. The commands are in
`docs/plugins.md`.

What is on the shelf:

- **Plumbing**, which carries no taste. An agent may add one of these instead of writing the same
  plumbing again, and says so:
  - `audio-beat-clock`: measure a song (tempo, bars, onsets, bands), and a clock;
  - `motion-eases`: eases, clamp, lerp, the progress of t through a span, an envelope over hits;
  - `motion-random`: seeded random numbers, a hash of an integer (the same in WGSL) and a stream;
  - `audio-listen`: the takes of a recording that match a description, heard by CLAP, each
    landed by its peak on a hit point;
  - `text-timed-cues`: lyrics and subtitles (LRC, SRT, VTT, Whisper or STT JSON), the line and word at t;
  - `text-fit`: the size that fits a width, word wrap (Thai too), a line's width at a tracking, the lines as text runs for review;
  - `motion-shot-list`: film time to shots, the transition's progress and the source frame at t;
  - `render-three-host`: three.js on the host's GPU;
  - `render-three-textures`: images from `io.image` as three.js textures and atlases;
  - `image-to-png`: WebP, AVIF, GIF and video frames converted to PNG once (ffmpeg);
  - `render-canvas-texture`: a Canvas2D canvas or RGBA bytes as a GPU texture for a WGSL pass;
  - `render-srgb`: the sRGB transfer functions, display values to linear light and back, WGSL and CPU;
  - `render-gltf-read`: glTF and GLB models read into plain arrays, matrices and materials;
  - `image-fit`: a still into a box of a Canvas2D frame, cover or contain, drawn small the same every time;
  - `image-regions`: named regions of a photograph (mask, box, centre), from SAM 3.1 or painted masks;
  - `render-gaussian-splats`: Gaussian splats on the host's GPU with a deterministic sort;
  - `render-bvh`: ray queries against a mesh's triangles on the GPU, closest hit and any hit;
  - `text-glyph-points` and `text-glyph-outlines`: text as a point set, or as contours and solids;
  - `review-av-timeline`: the sound and the picture's change on one timeline;
  - `review-shots`: any video measured shot by shot (cuts, camera move, levels, colour);
  - `review-picture-reuse`: the shots that show a picture again, a crop or zoom of it counting;
  - `format-placement-specs`: what placements accept, with sources, as requirements.json data;
  - `asset-provenance`: where each outside file came from, the ASSETS.md table and the credits.
- **Looks, motion and sound design** are added only when the person asks: `look-blur`,
  `look-screen-passes`, `look-paper-edges`, `look-row-glitch`, `look-film-grain`,
  `look-tonemap`, `look-vignette`, `text-scramble`, `text-glitch-titles`, `text-code-wall`,
  `text-glyph-morph`, `motion-keyframes`, `camera-keyframes`, `camera-shake`, `camera-ken-burns`,
  `format-safe-areas`, `format-broadcast-slate`, `audio-hall-ending`, `audio-voice-repace`.
- **Fonts:** `font-ibm-plex-mono`, `font-ibm-plex-sans`, `font-instrument-serif` and
  `font-stix-two-text`.

An agent never searches for plugins or suggests them on its own.

## Make it editable

The CLI and MCP can only show and change what the source exposes.

- **Literals with an `id`.** With `"stamp": true` in `shaderera.json`, an object literal with an
  `id` gets a `source` stamp (`file:line:col`). Return it from `inspect(t)` spread
  (`{ ...headline, box }`), so the stamp survives. Do not spread such a literal into a constructor
  that rejects unknown keys (three.js materials warn `'source' is not a property`).
- **Keep editable values literal.** `at: 2.4` can be found and changed; `at: base + 0.4` cannot.
  Put timing and appearance in data objects and compute from them.
- **Camera keys** are literals in one array: `{ id, at, eye: [x, y, z], target: [x, y, z], fov }`,
  and `inspect(t).camera` reports the keys in effect at t.
- **Say which space** an object lives in when it matters: `space: 'screen'` or `space: 'world'`.
- **Expose timing**, not only content: return the groups that hold `enterAt`, `exitAt` or
  `stagger` so they can be selected and changed.
- **Report text** as runs, `{ id: 'title', text: 'Hello', box: [160, 236, 420, 84] }` (`box` is
  `[x, y, width, height]` in frame pixels), so review can read it. Any other shape is skipped with
  no warning (`docs/protocol.md`, "Text runs"). Add a `bbox` (same form) for what should be looked
  at closely, so `still --object` can find it.
- **Params** are a JSON Schema in `shaderera.json` with titles and good defaults, for the few
  controls a non-programmer wants. If a param overrides a literal, say so in the README.
- **Variants** (`16:9`, `9:16`, a cutdown) are outputs the film lays itself out for. The source
  is opened with the variant's size in `host.manifest` and its name in `host.variant`
  (`undefined` for the manifest's own output): lay out by the name, not by guessing from the
  width and height.
- **`pick(t, x, y)`** returns `{ id, point? }` through the camera in effect, so a click selects.

## Keep it deterministic

`render(t)` is a function of `t`, the params and `host.seed`: no clocks, no `Math.random()` in
`render`, every asset awaited in `open`. `npx shaderera check` renders sampled frames in two
orders and compares them; export repeats the check on 8 of its own frames. The causes and fixes
are in `docs/determinism.md`; each renderer's traps (three.js's frame clock, readback rows padded
to 256 bytes, multisampling with blending on Dawn) are in its `docs/participants/` page. Canvas2D
pixels differ slightly between the browser and Node: export a film from one host.

## Expensive films

A film whose frames take seconds, or that is rendered partly outside the host, needs a few flags
that already exist. Use them, and tell the person what is running and how far it is: a long
command that prints nothing looks frozen.

- **Keep `open` light.** `open` runs in every host: each `--workers` host of a render, each chunk,
  each `still`, `check` and `review`. Work only `audio()` needs (a music bed made in code, a mix)
  goes in `audio()`, which runs once and only when the sound is wanted: a 28-minute film that
  made its bed sample by sample in `open` paid 57 s in every host for frames that never used it.
  Derived bytes that are the same every run (a decoded pyramid, an analysis) go through
  `io.cache`, so they are made once, not once a host.
- **Close each clip when its shot ends.** A clip's decoder holds its buffers until `close()` or
  the end of the render, in every host: a film of about 60 clips that closed none grew to about
  3.5 GB a host and could not run more than three. `frame(i)` after `close()` opens it again, with
  the same bytes.
- **Per-pixel work on the GPU.** A pass over every pixel in JavaScript (`getImageData`, a loop,
  `putImageData`) costs about 15 ms a 1080p frame; the same levels or grade in a WGSL pass over
  `host.gpu`, or a `look-*` plugin, costs well under one.
- **Call a heavy WGSL function from one site.** The browser inlines every call, so a large
  function called from several places compiles once per place and a pipeline can take seconds
  before the first frame (`guides/shader-compile.md`).
- **Measure before guessing.** `NODE_OPTIONS=--cpu-prof npx shaderera render --trusted --from 10
  --to 14` writes one `.cpuprofile` for the CLI and one for each host (without `--trusted` a host
  cannot write it): open them in Chrome DevTools, Performance, and see whether the time is in
  `open`, in the film's draw or waiting.
- **Check with fewer frames.** `check` renders every timestamp twice; at 5 s a frame, the default
  50 take over eight minutes. `npx shaderera check --times 4` still compares two orders.
- **Render in the background with progress.** `npx shaderera render --progress 2> render.log`
  writes `frame 120/360  2.1 fps` to stderr as it goes; read the end of the log to say how far
  it is, instead of guessing.
- **Bake what the host cannot run.** When a frame needs a program project code may not start (a
  native denoiser that keeps history, a simulation in another tool), or minutes of work that
  another program does better, make those frames a bake: declare it in `shaderera.json` `bakes`
  (the command, its inputs, the folder, how the frames are named; `docs/protocol.md`, "Bakes"),
  run `npx shaderera bake <name>`, and read the frames with `io.bake(name)`. Every command that
  renders refuses a bake whose inputs or frames changed since it was made, and a job pins it.
  Never read such frames with `io.read` and a cache you clear by hand: nothing would tie them to
  the code that made them.
- **Compare a final with what was approved.** Before handing over a final, put it beside the
  approved variant: `npx shaderera still 4 16.9 --variant final --compare animatic --sheet`. It
  writes each pair side by side with PSNR and mean ΔE; it measures and never judges, so look at
  the pairs and say what differs.

## HDR10

A film that computes more light than SDR shows can deliver HDR10 as well, when the person asks
for it. It opts in with an `hdr10` block in `shaderera.json`; the mastering display is the one the
person graded on, so ask for it rather than choosing one:

```json
"hdr10": { "mastering": { "peak": 1000, "min": 0.0001, "primaries": "p3-d65" }, "dither": "tpdf" }
```

The source then reads `host.range`. In `hdr10` its float `GPUTexture` layers declare their light
(`light: { transfer: 'linear', primaries: 'bt2020' }`, linear 1.0 at 203 cd/m²); canvases and
bytes stay SDR and are placed at Graphics White. In `sdr` the film tone-maps its own light, with
its own code or a plugin, and returns no layer with `light`: the SDR version is the film's own
render, never derived from the HDR one. Look at the SDR render; read the HDR one as numbers.

```sh
npx shaderera check --hdr10
npx shaderera deliver --hdr10 --sdr --master
```

That makes the HDR10 master (HEVC Main 10, or ProRes with `--format`) and the film's own SDR
render beside it. It needs ffmpeg 9.0 and WebGPU; `docs/delivery.md`, "HDR10", has the rest.

## Before you finish

Three different questions, never one score:

- **Technical:** `npx shaderera check`, `npx shaderera review` (add `--json` for one envelope an
  agent reads), export, and any measure scripts written for the project.
- **Brief:** does it keep the brief's content, brand and constraints, and follow `DIRECTION.md`?
  Declare what is fixed in `requirements.json`: review judges only what it declares.
- **Visual:** people look at the principal frames, a contact sheet and the playback. A passing
  check never certifies beauty. `guides/review.md` has the loop.
