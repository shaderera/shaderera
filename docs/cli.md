# CLI

```
shaderera <command> [--root <dir>] [--variant <name>] [--host node|browser] [--trusted] [--timeout <s>] [options]
```

| Command | What it does |
|---|---|
| [`inspect`](#inspect) | the source's state at t, or a value at every frame |
| [`check`](#check) | render each t twice in two orders and compare |
| [`still`](#still) | stills of any moment, a close look, a contact sheet |
| [`render`](#render) | export an mp4 or a ProRes mov (a png job: frames, `audio.wav`, `delivery.json`) |
| [`save`, `versions`, `undo`, `restore`, `diff`, `job`](#versions-and-jobs) | revisions and frozen render jobs |
| [`deliver`](#deliver) | a batch of every variant × locale into `out/deliveries/<batch>/` |
| [`plan`, `assemble`](#plan-render---chunk-assemble) | render a job's chunks on several machines |
| [`handoff`](#handoff) | a frozen project, its job and `REPRODUCE.md` in `out/handoff/<job>/` |
| [`review`](#review) | principal frames, a contact sheet and technical checks |
| [`bake`](#bake) | run a bake's command and stamp the frames it made outside the host |
| [`doctor`](#doctor) | what this machine and project have and lack |
| [`search`, `info`, `add`, `remove`, `publish`](#plugins) | find, copy in, remove and publish plugins |
| [`mcp`](#mcp) | serve the CLI as MCP tools over stdio |

`shaderera` alone, or `--help` / `-h` anywhere, prints the usage.

## Common flags

- **`--root <dir>`**: where to start looking for `shaderera.json`. Default: the working
  directory. The CLI walks up to the nearest directory that has one, so it works from `src/`.
- **`--variant <name>`**: open the project as one of its `variants`. An unknown name is refused.
- **`--host node|browser`**: overrides the manifest's `host` for this run. A project with `dom`
  cannot be run with `--host node`.
- **`--trusted`**: run the project without Node's permission model
  ([where project code runs](determinism.md#where-project-code-runs)). Given by the person running
  the command; a project cannot declare it.
- **`--timeout <s>`**: how long one call to the source may take before its process is stopped.
  Default 600 s: a GPU source's first call compiles its pipelines, which can take minutes on Dawn
  (a path tracer took about 165 s). In the browser host it bounds every DevTools call.

The commands that render the source (`check`, `inspect`, `still`, `render`, `review`) also take:

- **`--param k=v`** (repeatable): a param over the defaults and the variant's; the value is JSON
  when it parses (`--param count=4096`, `--param look=ascii`). A name the manifest's `params`
  schema does not declare is refused: `Unknown params: x. shaderera.json declares a, b.` `render
  --job` refuses it: a job froze its params.
- **`<t>...`** or **`--time <s>`** (repeatable): times in seconds, inside the film: from 0 up to
  but not including the duration (the last frame is at duration − 1/fps). `inspect` takes one,
  `still` any number; the others take none and refuse them.

The project's own console output goes to stderr, so stdout carries only the command's result. Set
`SHADERERA_DEBUG=1` to print a full error with its stack.

## Required plugins

Every command that finds a project reads its `shaderera.item.json`, if it has one. When the
project requires a `shaderera` range this is not in, or a package plugin that is not installed or
installed in the wrong version, the command refuses the project before anything renders and names
the two ways out:

```
shaderera: This project needs what is not installed (shaderera.item.json):
  - @shaderera/music ^0.1 (not installed)
Fix it one of two ways:
  npx shaderera add @shaderera/music@^0.1   install it
  npx shaderera remove @shaderera/music   stop requiring it, and write your own
```

There is no silent fallback. `npx shaderera doctor` lists the same problem as its `requires` item.

## `inspect`

| Flag | Default | |
|---|---|---|
| `<t>` or `--time <s>` | required | one time, see [the common flags](#common-flags) |
| `--path <p>` | the whole JSON | `a.b`, `a[2]`, `a[id=k5]`, `a["x y"]` |
| `--json` | off | pretty JSON instead of lines (ignores `--path`) |

One leaf per line, `path value`; arrays of objects with string `id`s are keyed by id. Numbers are
shown to 4 decimals. A source without `inspect` fails with `This source has no inspect(t).`

```
$ shaderera inspect 4.1 --path camera
camera.source src/composition.ts:37:10
camera.id "camera"
camera.eye [3.77, 1.6, 1.337]
camera.target [0, 0.5, 0]
camera.fov 44
camera.between[0] "k4"
camera.between[1] "k5"
```

**A curve.** `inspect --track <path> [--from s] [--to s] [--json]` reads the value at every frame
and, for a number or an array of numbers, its speed per second against the frame before: easing,
holds, overshoot and a stop that comes a frame late read off it without a picture. Below, the
lens changes pace after 4.1 s, as the camera passes keyframes k4 and k5.

```
$ shaderera inspect --track camera.fov --from 4 --to 4.2
4.000  44.1818  speed 1.8182/s
4.033  44.1212  speed 1.8182/s
4.067  44.0606  speed 1.8182/s
4.100  44  speed 1.8182/s
4.133  43.9697  speed 0.9091/s
4.167  43.8939  speed 2.2727/s
```

## `check`

| Flag | Default |
|---|---|
| `--times <n>` | 50 |
| `--seed <n>` | 1 |

```
$ shaderera check --times 5
✓ deterministic: 5 timestamps, two orders, inspect + pixels (49.0 ms/frame)
  preview vs final: mean 0.000, max 0 over 3 t
```

Exit 1 when any timestamp differs. What it does: [determinism.md](determinism.md#how-check-measures-it).

A shader that does not compile fails `check`, `still`, `render` and every other command that
renders, with the compiler's own message, line and column, and the project file and line it found
the code in:

```
shaderera: 1 shader error(s) during this call, so its result is not trusted:
WGSL error in shader "field" at 3:7 (src/field.wgsl:3): 'set' is a reserved keyword
    let set = total + 1.0;
        ^
```

## `still`

Stills of any moment straight from the source, rendered by the same host as `check` and export
(so the same errors fail them), for looking while you work.

| Flag | Default |
|---|---|
| `<t>...`, `--time <s>` (repeatable) | the times, see [the common flags](#common-flags): `still 6` fails on a 6 s film |
| `--every <s>` | also a frame every s seconds from 0 |
| `--sheet` | also a contact sheet, `<variant>-sheet.png` |
| `--diff` | render each t again after a far-away frame and count the channels that differ; exit 1 if any does |
| `--out <dir>` | `out/stills/` |
| `--region x,y,w,h` | none. Also writes that part of each still (frame pixels), `<variant>-<t>-<x>_<y>_<w>x<h>@<scale>.png` |
| `--object <id>` | none. The same, for the inspected object with that id: its `bbox` (`[x, y, width, height]` in frame pixels), which a source reports for what it wants looked at closely |
| `--scale <n>` | 1. Enlarges the part by whole pixels (1 to 16), so each source pixel shows as a block |
| `--compare <variant>` | none. Also renders each t in that variant, with the same `--param`s, and writes the pair side by side, `<variant>-vs-<other>-<t>.png` (the sheet too), with what was measured between them: PSNR over R, G and B (`identical` when the frames are the same) and the mean and largest ΔE (CIEDE2000; about 1 is what an eye can just tell), on frames matted over black as an mp4 shows them. It measures and never judges: no pass or fail. Both variants need one frame size |
| `--json` | off. One object: `stills`, each with `t`, `file`, `ms` and what was asked (`part`, `differing`, `compare`: `psnr` (null when identical), `deltaE`, `maxDeltaE`, `differing` pixels), and `sheet` |

```
$ shaderera still 0 2.5 --sheet --diff
out/stills/main-0.000.png  13 ms  differing channels after a jump: 0
out/stills/main-2.500.png  10 ms  differing channels after a jump: 0
out/stills/main-sheet.png
```

Before handing over a final, compare it with the variant that was approved:

```
$ shaderera still 4 16.9 --variant final --compare animatic
out/stills/final-4.000.png  212 ms
out/stills/final-vs-animatic-4.000.png  vs animatic: PSNR 38.41 dB, mean ΔE 0.412 (max 6.80), 18342 pixels differ
```

## `render`

Renders every frame `i / fps` in `[from, to)` at `intent: 'final'`, spread over the workers and
written in order. What each format is, and what was measured: [delivery.md](delivery.md).

The file is written as `<out>.partial` and renamed to `<out>` only when it is complete: while a
render runs, `<out>` is the previous film or nothing, never half a film. A render that fails or is
stopped (Ctrl-C) leaves no `.partial` and `<out>` as it was, its stems included. When the film is
finished but `<out>` cannot be replaced (on Windows, a player holding it open), the new film is
kept as `<out>.partial` and the error says so. A host error fails the render with
its frame (`Frame 214 (t 7.133 s) failed: …`), and a GPU device error (lost, removed, out of
memory) with several hosts says to render with fewer `--workers`: each holds its own GPU memory.
The file must hold every frame rendered; one ffmpeg finished short is refused.

Every file says which revision made it. `render` saves the project first, as `job` does (the same
files give the same id, so nothing new is saved when nothing changed); `render --job` uses the
job's revision and saves nothing. The id is printed (`revision: <id>`) and written into the file
as its `shaderera_revision` tag, which `ffprobe -show_entries format_tags` shows; `deliver` tags
its files with their job's revision too.

| Flag | Default |
|---|---|
| `--from <s>`, `--to <s>` | 0, `duration` |
| `--out <file>` | `<root>/out/<root folder name>.mp4` (`.mov` for ProRes); a given path is relative to the working directory, and inside the project it must be under `out/` (anything else in the project is saved into each revision) |
| `--format <f>` | `mp4` (H.264); `prores-hq` or `prores-4444` ([ProRes](delivery.md#prores)). A png handoff is a job's: `shaderera job --png` |
| `--master` | off: review quality (crf 18). On: crf 12, preset slow |
| `--crf <n>` | the quality's |
| `--bitrate <rate>` \| `--maxrate <rate>` | none: crf. A constant rate such as `15M`, or the crf capped at a rate ([rate control](delivery.md#rate-control)) |
| `--no-edit-list` | off. An mp4 without edit lists ([edit lists](delivery.md#edit-lists)) |
| `--stems` | off. One WAV per clip `group` beside the file ([stems](delivery.md#stems-and-captions)) |
| `--no-audio` | off. No audio stream (a png job: no `audio.wav`) |
| `--loudness=<LUFS>` | none. Move the mix to a target by one constant gain ([loudness](delivery.md#loudness)). Write it with `=`, since the value starts with a dash |
| `--encoder <x264\|nvenc>` | a review: `nvenc` where this ffmpeg and machine take the frame size, else `x264`; a master: `x264` ([encoders](delivery.md#quality-and-encoders)). `--crf n` gives NVENC cq n + 1 |
| `--workers <n>` | up to 4, two cores left free, at least 30 frames each; always 1 for a `sequential` source. Each is its own process, or its own Chrome |
| `--progress` | off: the progress line goes only to a terminal; on, also to a pipe |
| `--job <name\|file>` | none: render the working tree. With a job, its frozen revision, variant, params, seed, window and delivery; `--format`, `--bitrate` and the other delivery flags are then refused |
| `--chunk <i>`, `--plan <dir>` | with `--job`: one chunk of a [plan](#plan-render---chunk-assemble) |
| `--reuse <plan>`, `--changed <from>-<to>[,…]`, `--fix` | with `--job`: a plan that renders only the changed spans and takes every other frame from an earlier plan of the film ([below](#plan-render---chunk-assemble)) |

Progress goes to stderr, the result to stdout. Every render prints the file as ffprobe reads it
and, with audio, its loudness measured on the file:

```
$ shaderera render --from 0 --to 0.2 --out out/x.mp4
frame 6/6  24.3 fps
/path/to/project/out/x.mp4
6 frames in 0.3 s on 1 host(s), x264
file: h264 High yuv420p 1920×1080 30 fps, 8.40 Mb/s, aac 48 kHz 2 ch, edit list
audio: -23.0 LUFS, true peak -20.4 dBTP, range 0.0 LU
```

A source with `captions()` gets `<name>.srt` and `<name>.vtt` beside the file. A source that is
not deterministic is not exported: `render` deletes the file and exits 1 with the frames that
changed ([determinism.md](determinism.md#export-refuses-a-source-that-fails)). ffmpeg must be on
the PATH:

```
shaderera: render needs ffmpeg on the PATH: install it from https://ffmpeg.org/download.html
```

## Versions and jobs

A project's saved revisions and render jobs live in `versions/` (keep it with the project):

| Command | What it does |
|---|---|
| `save [--label text] [--note text]` | saves the project's files as a revision; the same files always get the same id, and saving them again says so (`same files as revision <id>; label added`). Links (symlinks, junctions) are never followed or stored |
| `versions [--json]` | the log of saves, restores and undos, newest last, and the jobs |
| `undo` | returns to the previous revision; unsaved edits are saved first, so nothing is lost |
| `restore <revision>` | makes the project that revision (the current state is saved first) |
| `diff <a> [<b>] [--stat]` | files added, removed and changed from revision a to b (or the working tree), with a unified diff of text files |
| `job [--variant v] [--params json] [--revision id] [--name n] [--label l] [--from s] [--to s] [--host h] [--format f] [--png] [--master] [--bitrate r \| --maxrate r] [--no-edit-list] [--stems] [--bits 16] [--replace]` | freezes a render job (`job/3`) in `versions/jobs/<name>.json`: the revision (the project is saved first unless one is given), the host, the variant, the complete params (an unknown name is refused), the seed, the window, the delivery settings and the installed packages the source and its DOM import, by content, and the stamp of every bake it reads ([what a job pins](delivery.md#handoff)). Its `id` hashes all of that. The same inputs return the job already there; a `--name` that holds different inputs is refused unless `--replace` |
| `render --job <name>` | renders exactly that job in its host, from the revision's frozen copy, whatever the project became; refuses another `--host`, a package the job executes that changed, or another Shaderera version |

```
$ shaderera save --label "client round 1"
3ff052ac48653666  14 files  client round 1
$ shaderera job --variant portrait --params '{"headline":"Ripe on the day it ships."}'
saved versions/jobs/portrait-3ff052ac-91d0be.json — render it with: shaderera render --job portrait-3ff052ac-91d0be
$ shaderera render --job portrait-3ff052ac-91d0be
shaderera: Job portrait-3ff052ac-91d0be cannot render as it was frozen: three@0.186.1 has different
contents than when the job was made. Reinstall what it was made with, or make a new job from
revision 3ff052ac48653666 to render with what is installed now.
```

A job holds execution inputs and references, never the film.

## `deliver`

`shaderera deliver [--variants main,a,b] [--locales en,th] [--format f] [--png] [--master]
[--bitrate r | --maxrate r] [--no-edit-list] [--stems] [--bits 16] [--no-audio] [--loudness=LUFS]
[--name batch] [--job a --job b] [--replace]` saves the project once, makes one job per variant ×
locale (named `<batch>-<variant>[-<locale>]`), renders and reviews each, and writes
`out/deliveries/<batch>/`. A batch name that holds other inputs is refused unless `--replace`.
Exit 1 when any output fails, after rendering the rest. See [delivery.md](delivery.md#batch).

## `plan`, `render --chunk`, `assemble`

`shaderera plan --job <name> [--chunks 4] [--out dir]`, then `shaderera render --job <name>
--chunk <i> [--plan dir]` on any machine, then `shaderera assemble --plan <dir> [--out file]
[--mixed-hosts] [--no-audio] [--loudness=LUFS]`: the same file as one `render --job`. See
[delivery.md](delivery.md#rendering-a-job-on-several-machines).

After a small edit, `shaderera render --job <new> --reuse <earlier plan> --changed <from>-<to>[,…]
[--fix] [--plan dir]` writes a plan of the new job (by default `out/<new>.plan`) that renders only
the changed spans, in seconds, and takes every other frame from the earlier plan's chunks; then
`assemble --plan <dir>` as usual. Before rendering, it renders a sample of the reused frames again
and compares them with the earlier ones, and refuses a frame that differs, naming it and its span.
`--fix` renders around such a frame instead. See
[delivery.md](delivery.md#re-rendering-only-what-an-edit-changed).

```
$ shaderera render --job b5 --reuse out/a5.plan --changed 330-331
chunk 1: 25 frames from 330 s in 3.2 s
/path/to/project/out/b5.plan/plan.json: 25 frames rendered, 7475 reused from /path/to/project/out/a5.plan; 34 reused frames rendered again matched
then: npx shaderera assemble --plan /path/to/project/out/b5.plan
```

## `handoff`

`shaderera handoff <job> [--verify] [--clean-install] [--trusted]` writes `out/handoff/<job>/`.
Exit 1 if `--verify` finds a frame that differs. See [delivery.md](delivery.md#handoff).

## `review`

`shaderera review [--variant name] [--out dir] [--requirements file] [--quick] [--json]` renders
the principal frames, writes them with a contact sheet, and runs the technical checks. The CLI and
the `review` MCP tool run the same code (`src/review/review.ts`).

- **Frames:** the source's `shots` (inspect, top level), the midpoint between consecutive shots
  (labelled `transition`) and the last frame; without shots, 7 evenly spaced frames and the last.
  Each is a full-size PNG plus a thumb at most 1600 px long, in `<root>/out/review/` (a variant:
  `out/review/<variant>/`), with `contact-sheet.png`, labelled `t` and shot.
- **Requirements:** `requirements.json` in the root, or `--requirements file` (below).
- **Checks:** each prints `✓` (pass), `✗` (fail), `?` (unknown: could not be measured, or
  nothing to check against) or `·` (info: measured, with nothing in requirements.json to judge it
  against), its title and what it measured. A check that cannot be measured is never a pass.
- **Only what is declared is judged.** Errors fail always: determinism, readback, missing glyphs,
  failed assets. Craft rules fail only when requirements.json sets them: `endHold`,
  `readingTime`, `textOverlap`, `noBlankFrames`, `safeArea` (and exact `copy`, which must be inside
  the frame). Without them those checks report what they measured as info. There are no defaults.

| Check | How it measures |
|---|---|
| `format` | manifest width, height, fps, duration against `requirements.format`; unknown without one |
| `determinism` | `check` on 6 sampled t (two orders, inspect + pixels); `--quick` skips it |
| `blank-frames` | a preview frame every 0.25 s; luma std-dev < 1 outside the first and last 0.3 s, listing the t; fails only with `noBlankFrames: true` |
| `end-hold` | final frames at 10 fps over the last 3 s; the trailing span where the mean abs diff per channel to the previous sample is < 0.5; fails below `requirements.endHold` s |
| `text-fit` | every [text run](protocol.md#text-runs) (`{ text, box: [x, y, w, h] }` anywhere in inspect) at the sampled t: inside `requirements.safeArea` margins, or the frame when `requirements.copy` is set; reports the minimum margin |
| `text-overlap` | two runs at the same t overlapping more than `requirements.textOverlap` of the smaller box; without it, how many pairs overlap and the largest overlap |
| `reading` | the longest visible stretch of each text (0.25 s samples, opacity ≥ 0.5); fails a text shown for less than `requirements.readingTime` (max(min, characters / charsPerSecond)); without it, the shortest |
| `glyphs` | each run's characters in the cmap (formats 4 and 12) of the fonts registered through `io.font` for its family; a family not registered there is unknown |
| `copy` | each `requirements.copy` text appears verbatim (whitespace normalised) in some run at some sampled t |
| `assets` | `io.read` / `io.font` calls that failed in the host |
| `readback` | when `width * 4` is not a multiple of 256: the hero shot at W×H and at ceil(W/64)·64×H, mean luma difference on a common grid (limit 4); `--quick` skips it |
| `alpha` | % non-opaque pixels in the principal frames; non-opaque is unknown (diagnostic) |
| `timing` | each declared `timing` at its frames; none without a declaration |
| `textless` | for a `textless` variant: text shown in inspect or the DOM fails it; text drawn without either cannot be seen, and the check says so |

`requirements.json` (`"version": 1`) holds what the person declared, never the film:

| Key | What review or deliver does with it |
|---|---|
| `copy` | `[{ text, id?, variants? }]`: each text must appear verbatim in the outputs it names (all by default; `main` is the manifest's own format) |
| `format` | `{ width, height, fps, duration }` the main output must have |
| `variants` | the variants that must be delivered, each checked like the main output |
| `safeArea` | `{ top, right, bottom, left }` margins as fractions: what `text-fit` judges |
| `endHold`, `readingTime`, `textOverlap`, `noBlankFrames` | the craft rules above; unset, they are info |
| `timing` | `[{ path, at \| from + to, equals + tolerance \| min \| max \| changes }]`: values at inspect paths, at a time or over a window (every frame). `{ "path": "objects[id=logo].x", "at": 1, "equals": 100 }` lands the logo on the downbeat; `{ …, "from": 1, "to": 3, "changes": false }` holds it |
| `placements` | the placement each output is delivered to, by variant ([placements](delivery.md#placements)) |
| `locks` | what must not change: a file, an id, a time (`{ kind: 'time', at, id? }`) or an approved frame (`{ kind: 'frame', at }`). Nothing enforces it: an agent reads it before a change |
| `brief`, `items` | the brief as given, and each requirement with its kind and status, for people and agents |

The report (`--json`) also carries diagnostics, never verdicts: exposure per frame (mean luma, %
clipped ≥ 250, % crushed ≤ 5), text contrast per run (WCAG ratio from the 10th and 90th luminance
percentiles in its box), motion (% static samples) and audio (clips and their coverage).

```
✓ blank frames · 0 of 49 samples (every 0.25 s) flat (luma std-dev < 1) outside the first and last 0.3 s
· end hold · 2 s held at the end: pixels still 2 s
? copy · no copy in requirements
✓ readback · mean luma diff 1.43 on a 108×135 grid, 1080 vs 1088 px wide at t=6 (limit 4) @ 6
/path/to/project/out/review/contact-sheet.png
8 frames in 4.4 s
```

## `bake`

`shaderera bake [name...]` runs each named [bake](protocol.md#bakes)'s command (every declared
bake when none is named) in the project folder, with your rights, and when it exits 0 stamps the
frames it made in `versions/bakes/<name>.json`: the inputs' hash, and each frame's size and hash.

```
$ shaderera bake beauty
beauty: 360 frames, 412.6 MB in D:\beauty, 1843.2 s; stamped
```

A command that fails, writes no frames, or leaves a gap in their numbers stamps nothing, and an
input that changed while it ran is refused. `check`, `inspect`, `still`, `render` and `review`
refuse a bake that is not made or stale, before anything renders:

```
shaderera: Bake beauty is stale: scene/sofa.json changed since it was made. Run shaderera bake beauty.
```

## `doctor`

`shaderera doctor [--json]` lists what this machine has and lacks: Node, Shaderera, ffmpeg and
ffprobe, the encoders and filters deliveries use (libx264, aac, prores_ks, pcm_s24le, ebur128,
amultiply), NVENC at 1920×1080, Chrome. Inside a project: its host, `webgpu`'s version, the
adapter with every feature and its limits (asked in a child process), and more than one `webgpu`
installed, which crashes a host, and a package plugin the project requires and lacks (`requires`,
[above](#required-plugins)). Each lack says how to fix it.

The limits are the ones films run into, as the Node host's device gets them (it asks for the
adapter's maximum). They come from the GPU and its backend, not from Shaderera: Dawn on D3D12 caps
a buffer at 2 GB. `--json` carries them as `limits` on the `gpu` item.

| Limit | What it bounds |
|---|---|
| `maxBufferSize` | one buffer, in bytes: a particle pool or a scene's triangles must fit, or be split |
| `maxStorageBufferBindingSize` | how much of a buffer one storage binding reads, in bytes |
| `maxTextureDimension2D` | a 2D texture's width and height, in pixels: the frame and every render target |
| `maxTextureArrayLayers` | the layers of one texture array, such as a stack of baked frames |

## Plugins

Plugins come from a folder or the URL of one: `--from <dir|url>`, else `SHADERERA_PLUGINS`, else
Shaderera's own at `https://shaderera.com/r`. All of it is in [plugins.md](plugins.md).

| Command | What it does |
|---|---|
| `search <words> [--type t] [--category c] [--tag x] [--json]` | full-text over names, descriptions and code |
| `info <name>[@range] [--json]` | what it is, its licence, what it copies and is built on, its README |
| `add <name>[@range] [--force]` | copies a plugin and what it is built on into the project; a package plugin is installed and recorded in `shaderera.item.json` |
| `remove <name>` | uninstalls a package plugin and stops requiring it |
| `publish [dir] --from <folder> [--force]` | puts a plugin into a folder of plugins |

`add` never replaces a file the project already has; `--force` replaces only the plugin named. A
copied plugin's files are the project's own code: to stop using one, delete them.

## `mcp`

Serves the operations above as MCP tools over stdio. Accepts `--root`, `--trusted` and
`--timeout`. See [mcp.md](mcp.md). The CLI hosts no agent: the person's own agent drives these
commands and the MCP server.

## Exit codes

| Code | When |
|---|---|
| 0 | the command ran and nothing failed; or it printed the usage |
| 1 | it ran and found a failure: `check` found a difference; `review` or `deliver` has a failing check; `still --diff` found a frame that depends on history; `handoff --verify` found a different frame; `doctor` is missing something needed |
| 2 | it could not run: an unknown command or flag, a missing tool, a project that does not build or open, a shader that does not compile, a render that threw; printed as `shaderera: <message>` |

## `--json`: one envelope

Every command but `mcp` takes `--json`: stdout is then one JSON object, the exit code unchanged.

```json
{
  "shaderera": "result/1",
  "command": "review",
  "ok": false,
  "exitCode": 1,
  "findings": [
    {
      "code": "text-fit",
      "severity": "error",
      "message": "text inside safe area: title (bottom)",
      "t": [1.5],
      "bbox": [96, 1700, 888, 120]
    }
  ],
  "result": { "checks": [] }
}
```

- `findings`: `code` (a review check's id, `determinism`, `history`, `clock`, `shader`, `gpu`,
  `usage`, `environment`, `doctor:<item>`, `error`), `severity` (`error` fails; `warning` and
  `info` never do), `message`, and when known `t`, `file` and `line` (a shader), `bbox` (frame
  pixels: the text run or the overlap), `output` (a batch's job), `measured`.
- `result`: the command's own JSON (`inspect`, `still`, `review`, `versions`, `doctor`,
  `search`, `info`); `log`: the lines any other command printed.
