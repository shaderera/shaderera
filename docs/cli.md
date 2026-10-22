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
| [`login`, `whoami`, `logout`, `share`, `fork`](#shadereracom-login-whoami-logout-share-fork) | send a film to shaderera.com, and fork one from there |
| [`studio`, `telemetry`](#studio-telemetry) | the local bridge of the studio page on shaderera.com, and its telemetry switch |
| [`mcp`](#mcp) | serve the CLI as MCP tools over stdio |

`shaderera` alone, or `--help` / `-h` anywhere, prints the usage.

## Common flags

- **`--root <dir>`**: where to start looking for `shaderera.json`. Default: the working
  directory. The CLI walks up to the nearest directory that has one, so it works from `src/`.
- **`--variant <name>`**: open the project as one of its `variants`. An unknown name is refused.
  In the files named after it (`out/<project>-<variant>.mp4`, `out/stills/<variant>-<t>.png`,
  `out/review/<variant>/`), what a file name cannot hold becomes `_`: `16:9` is `16_9`.
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
written in order. Every worker opens at once with the first, so a render pays the source's `open`
about once, not once a worker. What each format is, and what was measured:
[delivery.md](delivery.md).

The file is written as `<out>.<pid>.partial` (the render's process id, so two renders to one
`<out>` never share it) and renamed to `<out>` only when it is complete: while a render runs,
`<out>` is the previous film or nothing, never half a film. A render that fails or is
stopped (Ctrl-C) leaves no `.partial` and `<out>` as it was, its stems included. When the film is
finished but `<out>` cannot be replaced (on Windows, a player holding it open), the new film is
kept as `<out>.<pid>.partial` and the error says so. A host error fails the render with
its frame (`Frame 214 (t 7.133 s) failed: …`), and a GPU device error (lost, removed, out of
memory) with several hosts says to render with fewer `--workers`: each holds its own GPU memory.
The file must hold every frame rendered; one ffmpeg finished short is refused.

Every file says which revision made it. `render` saves the project first, as `job` does (the same
files give the same id, so nothing new is saved when nothing changed); `render --job` uses the
job's revision and saves nothing. The id is printed (`revision: <id>`) and written into the file
as its `shaderera_revision` tag, which `ffprobe -show_entries format_tags` shows; `deliver` tags
its files with their job's revision too. A save hashes again only the files whose size,
modification time or inode changed since the last one (`.shaderera/hashes.json`, as git's index
does), and always a file modified within 2 s of when it was last hashed: on a project of several GB
of footage it takes a moment, not the time to read all of it.

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
| `save [--label text] [--note text]` | saves the project's files as a revision; the same files always get the same id, and saving them again says so (`same files as revision <id>; label added`). Links (symlinks, junctions) are never followed or stored, and files that hold secrets are never stored: `.env`, `.env.*`, `.envrc`, `.dev.vars`, `.dev.vars.*`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `*.p12` and `*.pfx`, and a `.mcp.json` that gives a server `env` or `headers` (where keys go) or does not parse, at any depth. A `.mcp.json` that only names commands, as a new project's does, is stored like any file |
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
[delivery.md](delivery.md#rendering-a-job-on-several-machines). A chunk's frames go round
`--workers` hosts on its machine (the same default as `render`), and its file holds the same
frames however many.

After a small edit, `shaderera render --job <new> --reuse <earlier plan> --changed <from>-<to>[,…]
[--fix] [--plan dir]` writes a plan of the new job (by default `out/<new>.plan`) that renders only
the changed spans, in seconds, and takes every other frame from the earlier plan's chunks; then
`assemble --plan <dir>` as usual. Before rendering, it renders a sample of the reused frames again
and compares them with the earlier ones, and refuses a frame that differs, naming it and its span.
`--fix` renders around such a frame instead. See
[delivery.md](delivery.md#re-rendering-only-what-an-edit-changed).

```
$ shaderera render --job b5 --reuse out/a5.plan --changed 330-331
chunk 1: 25 frames from 330 s in 3.2 s on 1 host(s)
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

- **Frames:** the source's `shots` (inspect, top level) and the last frame; without shots, 7
  evenly spaced frames and the last. A shot is a moment `{ id, at }` or a span
  `{ id, start, end }` (on screen from `start` up to `end`; other fields are ignored, so
  `motion-shot-list`'s `list.shots` can be returned as is). A moment's frame is `at`, and the
  `transition` frame between two moments is their midpoint. A span's frame is the middle of the
  part no neighbouring shot overlaps, and the `transition` frame is the middle of the overlap
  with the next span; spans that meet at a hard cut have none.
  Each is a full-size PNG plus a thumb at most 1600 px long, in `<root>/out/review/` (a variant:
  `out/review/<variant>/`), with `contact-sheet.png`, labelled `t` and shot.
- **Requirements:** `requirements.json` in the root, or `--requirements file` (below).
- **Checks:** each prints `✓` (pass), `✗` (fail), `?` (unknown: could not be measured, or
  nothing to check against) or `·` (info: measured, with nothing in requirements.json to judge it
  against), its title and what it measured. A check that cannot be measured is never a pass.
- **Only what is declared is judged.** Errors fail always: determinism, readback, missing glyphs,
  failed assets. Craft rules fail only when requirements.json sets them: `endHold`,
  `readingTime`, `textOverlap`, `noBlankFrames`, `safeArea`, `captions` (and exact `copy`, which
  must be inside the frame). Without them those checks report what they measured as info. There are no defaults.

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
| `captions` | the subtitle sidecar (`captions()`): each caption's characters per second, duration, gap to the next, line count, longest line (characters are grapheme clusters, so a Thai syllable with its marks counts once) and overlaps; fails a caption over a declared `requirements.captions` limit; without one, the highest cps, most lines, longest line, shortest duration, smallest gap and overlapping pairs as info. A caption every export refuses (no finite end, such as an LRC cue's last line at `Infinity`) fails it always ([delivery.md](delivery.md#stems-and-captions)) |
| `textless` | for a `textless` variant: text shown in inspect or the DOM fails it; text drawn without either cannot be seen, and the check says so |

`requirements.json` (`"version": 1`) holds what the person declared, never the film:

| Key | What review or deliver does with it |
|---|---|
| `copy` | `[{ text, id?, variants? }]`: each text must appear verbatim in the outputs it names (all by default; `main` is the manifest's own format) |
| `format` | `{ width, height, fps, duration }` the main output must have |
| `variants` | the variants that must be delivered, each checked like the main output |
| `safeArea` | `{ top, right, bottom, left }` margins as fractions: what `text-fit` judges |
| `endHold`, `readingTime`, `textOverlap`, `noBlankFrames` | the craft rules above; unset, they are info |
| `captions` | `{ maxCps?, maxLineChars?, maxLines?, minDuration?, minGap? }`: limits on the subtitle sidecar, in grapheme clusters and seconds (an overlap is a negative gap); only the keys set are judged |
| `timing` | `[{ path, at \| from + to, equals + tolerance \| min \| max \| changes }]`: values at inspect paths, at a time or over a window (every frame). `{ "path": "objects[id=logo].x", "at": 1, "equals": 100 }` lands the logo on the downbeat; `{ …, "from": 1, "to": 3, "changes": false }` holds it |
| `placements` | the placement each output is delivered to, by variant ([placements](delivery.md#placements)) |
| `locks` | what must not change: a file, an id, a time (`{ kind: 'time', at, id? }`) or an approved frame (`{ kind: 'frame', at }`). Nothing enforces it: an agent reads it before a change |
| `brief`, `items` | the brief as given, and each requirement with its kind and status, for people and agents |

The report (`--json`) also carries diagnostics, never verdicts: exposure per frame (mean luma, %
clipped ≥ 250, % crushed ≤ 5), text contrast per run (WCAG ratio from the 10th and 90th luminance
percentiles in its box), motion (% static samples), audio (clips and their coverage) and captions
(each caption's `start`, `end`, `duration`, `cps`, `gap`, `lines`, `longestLine`, `overlaps`; null
without `captions()`).

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
[above](#required-plugins)). Each lack says how to fix it. It also says whether this machine is
signed in to the films API (`sign-in`: as whom, which API, until when; `SHADERERA_API` names
another) and whether the project can be shared (`share`: the licence it declares). Neither is
needed, so neither fails `doctor`.

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

Plugins come from the site's `/r`: `--site <origin>`, else `SHADERERA_SITE`, else
`https://shaderera.com/r`; or from a folder of plugins, `--site <dir>`. All of it is in
[plugins.md](plugins.md).

| Command | What it does |
|---|---|
| `search <words> [--type t] [--category c] [--tag x] [--json]` | full-text over names, descriptions and code |
| `info <name>[@range] [--json]` | what it is, its licence, what it copies and is built on, its README |
| `add <name>[@range]... [--force]` | copies plugins and what they are built on into the project; a package plugin is installed and recorded in `shaderera.item.json`. All of them resolve first: one that does not stops them all |
| `remove <name>...` | uninstalls package plugins and stops requiring them; each must be one the project uses, or none is removed |
| `publish [dir]... --site <folder> [--force]` | puts plugins into a folder of plugins, each in turn; the end names any that failed |

`add` never replaces a file the project already has; `--force` replaces only the plugin named. A
copied plugin's files are the project's own code: to stop using one, delete them. `info` takes one
name. `--site <dir>` wants a folder of published plugins: a folder of plugin sources is refused,
with the publish step to run first.

## shaderera.com: `login`, `whoami`, `logout`, `share`, `fork`

A film can be shared on shaderera.com, where it plays in the viewer's browser, and anyone can fork
a shared film into a project of their own. These three commands and [`studio`](#studio-telemetry)
are the only ones that talk to the site. They run only when called: nothing runs in the
background, and the CLI sends no telemetry.

They talk to two origins, each reached over https (plain http only on this machine: `localhost`,
`127.0.0.1`):

- **The films API**, `--api <origin>`, else `SHADERERA_API`, else `https://api.shaderera.com`:
  where films are shared to and forked from, and what `login` signs in to (`/api/v1`). Another
  films API serves the same routes.
- **The site**, `--site <origin>`, else `SHADERERA_SITE`, else `https://shaderera.com`: the pages
  people see, a film's page and the studio page, and the plugins at `<site>/r`.

| Command | What it does |
|---|---|
| `login [--api origin] [--no-open]` | signs in with GitHub and keeps this machine's token for that API in `~/.shaderera/tokens.json` (readable by you only). It never prints a token |
| `login --token <token> [--api origin]` | keeps a token given by hand, in the same file |
| `whoami [--api origin] [--json]` | who this machine is signed in as, the name the API knows it by, and until when; exits 1 when it is not signed in |
| `logout [--api origin] [--all]` | signs this machine out (`--all`: every machine of yours) and forgets its token |
| `share [--film id] [--title t] [--no-media] [--dry-run] [--host h] [--trusted] [--timeout s] [--yes] [--api origin] [--site origin] [--json]` | builds the project's web player, and sends the project, the player, a poster and a loop as a new film, or as a new version of the film it shared to before |
| `fork <film\|url>[@version] [dir] [--api origin] [--site origin] [--json]` | copies a shared version into a new folder (`./<film>` by default), as an ordinary project |

**`login`** signs in with GitHub's device flow:

1. It prints a code and opens `https://github.com/login/device` in your browser (`--no-open`
   only prints the address).
2. You enter the code and approve. GitHub asks for no permissions: the API sees your public
   profile only.
3. `login` sends GitHub's token once to the API (`POST /api/v1/auth/github`) with this machine's
   name (its host name). The API answers with a token for this machine, your handle (your GitHub
   login) and when the token stops working (90 days). `login` keeps that token, and never keeps
   GitHub's.

```
$ npx shaderera login
Enter the code WDJB-MJHT at https://github.com/login/device
opening https://github.com/login/device
Signed in as ana: this machine as "studio-mac", until 2027-01-19
```

Each machine has its own token: signing in on a second one keeps the first signed in, and
signing in again on the same one replaces its token. `logout` signs this machine out at the API
(`--all` signs out every machine, say for a lost laptop) and then forgets the token; a token the
API no longer takes is forgotten too, and one the API cannot be reached for is kept, to sign out
later. `whoami` asks the API whose the token is (`GET /api/v1/auth/me`).

The sign-in uses the client id of Shaderera's GitHub OAuth App, built into `shaderera`, or
`SHADERERA_GITHUB_CLIENT_ID` when it is set. Until that App exists, `login` without `--token`
says so and stops, and `--token` is the way in; an API without its GitHub App set up answers
`503`, and `login` says the same.

**What `share` sends** is the project's files as a revision holds them (`save`,
[above](#versions-and-jobs)), and nothing else:
- never `out/`, `versions/`, `.shaderera/` or `.claude/` at the root, `node_modules/` or `.git/`
  anywhere, or a link (symlink, junction);
- never a file that holds secrets, which a revision never holds (`save`, above): it names the
  ones it leaves out;
- besides the files, the licence (package.json's `license`), the title of a new film and the
  version of `shaderera` that sent it.

**A version is played from its web player**, which `share` builds on your machine into
`.shaderera/player/` and sends beside the source as `player` ([player.md](player.md)): the
runner page and worker with the film bundled, the film's files, an H.264 proxy of each video in
them (made with ffmpeg) and the bakes' frames. The site stores and serves it and builds nothing.
Only the pages the player lists as its parents may frame it and get its port: the origins the
API names (`parents` in its `GET /api/v1/films/health`, read without the token before the build:
its films app and the site that shows its films), else the site alone. A player that does not
build (a bake not made or stale, a video ffmpeg cannot read, a bundling error) stops the share
before anything is sent.

**A poster and a loop** go with each version, for the site to show the film by: the main
variant's frame at the film's middle, a webp at most 1280 px wide and 500 KB; and its first
min(4 s, duration), a silent H.264 mp4 480 px wide and at most 4 MB. `share` renders them with
the CLI's own host and ffmpeg into `.shaderera/media/`, after you confirm; `--host`, `--trusted`
and `--timeout` apply to that render, as to a `render`'s. One that does not
render (no ffmpeg, a frame that fails, too large) is left out with a warning, and the film is
shared without it. `--no-media` renders and sends neither.

Before sending, it prints how many files and bytes it will send, the player's, to which API and
film, the pages the player plays on, the secrets it leaves out, and asks.
Off a terminal, or with `--json`, it needs `--yes`, or it sends nothing and exits 2. Declining
sends nothing and exits 1. Only the files the API does not already have are uploaded, each one
checked against its sha256 as it is read.

**The API's limits** come with its health (`limits`: bytes a file and a version, files a
version, hashes an ask, a poster's and a loop's bytes). After the poster and loop, and before
anything is uploaded, `share` checks the version against them: one over a limit is refused with
each limit it breaks, and nothing is sent. An API that names none is not checked here; its
routes still refuse what is over. An API whose health does not answer in 10 s, answers an error,
or answers something other than JSON (a proxy's page) stops the share before the build, with
`couldn't read the films API's limits at <api>: <why>`.

**`--dry-run`** does everything a share does on this machine and sends nothing: it needs no
token (it says whether you are signed in), builds the player, renders the poster and loop
(unless `--no-media`), and names each limit the version would break. When it cannot read the
limits it warns with the same line and goes on, unchecked (`limitsChecked: false`). It exits 0
when a share would go through, 1 when it is over a limit. With `--json` its result is `dryRun`,
`api`, `signedIn`, `film` (null for a new one), `title`, `licence`, `files`, `bytes`, `player`,
`parents`, `notSent`, `poster`, `loop`, `warnings`, `limits`, `limitsChecked` and `over`.

`--to`, `--from` and `--parent` are gone from these commands and the plugin commands: each
says what to use instead (`--api <origin>`, `--site <origin|folder>`). `render`'s and `job`'s
`--from` and `--to` are times, as before.

- **The licence** is package.json's `license`: an SPDX id such as `MIT`, or `UNLICENSED` for all
  rights reserved, which a new project starts with. A project without one is refused before
  anything is sent, and before the token is looked for.
- **The film** a project shares to is noted per API in `.shaderera/share.json`, which is never
  sent or forked. The first share makes a new film titled `--title`, else package.json's `name`,
  else the folder's name; later shares make new versions of it. `--film <id>` shares to a film
  you own, and is noted for next time.
- **The token** is the one `login` kept for that API. It goes only in the request's
  `Authorization` header. Without one, or when the API refuses it, the error ends
  `Sign in: npx shaderera login`.
- **An error** names the call, the API, the status and the API's own sentence. An answer that is
  not the API's JSON (a proxy's or a site's page) shows only its first line.

```
$ npx shaderera share
share: 14 files, 2.1 MB, and a player of 31 files, 3.4 MB, to https://api.shaderera.com as a new film "neon-rain" (licence MIT)
  the player plays on https://api.shaderera.com, https://shaderera.com
  not sent: .env
Send? [y/N] y
  with a poster of 48 KB and a loop of 612 KB
shared film k3x9q2mfa7 version 3ff052ac4865: 33 of 33 files were new
  https://shaderera.com/film/k3x9q2mfa7
```

The address it prints is the film's page, the canvas with the film open, as the API answers it
(else `<site>/film/<film>`).

**`fork`** takes a film's id, `<id>@<version>` (a version may be the start of one) or the address
of its page on the site (`https://shaderera.com/film/<id>`), which it looks up on the API (a page
of any other origin is refused); without a version it takes the latest. It needs no
token and sends none. Every path is checked as a revision's is, every file against its sha256,
and nothing is written until all of them match; the folder must be new or empty. The new
project's first `share` makes a new film, marked as forked from that version.

```
$ npx shaderera fork https://shaderera.com/film/k3x9q2mfa7 my-rain
forked "neon-rain" (k3x9q2mfa7) version 3ff052ac4865 into /work/my-rain: 14 files, 2.1 MB, licence MIT
```

With `--json`, `share`'s result is `api`, `film`, `created`, `version`, `url`, `files`, `bytes`,
`player` (`{ files, bytes }`), `parents`, `uploaded`, `notSent`, `poster` and `loop` (their bytes,
or null when not sent) and `warnings`; `fork`'s is `api`, `dir`, `film`, `title`, `owner`,
`version`, `licence`, `files` and `bytes`.

## `studio`, `telemetry`

| Command | What it does |
|---|---|
| `studio [--connect id] [--site origin] [--api origin] [--origin dev-origin]... [--no-open]` | serves the project to the studio page on the site until Ctrl-C |
| `telemetry off\|on\|status` | whether the studio page reports usage counts |

`studio` is the local bridge of the studio, a page on shaderera.com that drives the project on your
machine. It makes a studio session id, or takes the one a studio page made with `--connect <id>`,
and opens `<site>/studio/<id>#<nonce>` in your browser (`--no-open` prints the address instead): it
pairs only with the page that holds that nonce. The site is
`--site <origin>`, else `SHADERERA_SITE`, else `https://shaderera.com`. Share sends films to the
films API, `--api <origin>`, as `share --api` and with the same default. It also takes `--root`, `--host`, `--trusted` and `--timeout`, for the renders the page
asks for.

- **The bridge.** It listens on 127.0.0.1 only and answers only the site's origin (and
  `--origin` ones) with the session's secret, which reaches the page end to end through the site's
  relay.
- **What the page does through it.** The page previews the project with its runner, hears its
  edits, renders into `out/studio/` with the CLI's own hosts, and shares with `share`, as you.
- **The protocol** is [studio.md](studio.md).

The studio page reports usage counts to shaderera.com, which stores them in PostHog: never code,
file names, params, frames or titles. The CLI sends nothing itself. `shaderera telemetry off`
(kept in `~/.shaderera/config.json`) or `SHADERERA_TELEMETRY=0` turns it off. `studio` says so the
first time it runs.

```
$ npx shaderera studio
project  /work/neon-rain
bridge   http://127.0.0.1:52144 (for https://shaderera.com only)
share to https://api.shaderera.com
opening  https://shaderera.com/studio/k3x9q2
paired: the studio page drives this project. Ctrl-C stops.
```

## `mcp`

Serves the operations above as MCP tools over stdio. It starts in any folder: each tool call
finds its project from its `root`, or from `--root` (default: the current folder) and above.
Accepts `--variant` and `--host` (every call's defaults), `--trusted` and `--timeout`. See
[mcp.md](mcp.md). The CLI hosts no agent: the person's own agent drives these
commands and the MCP server.

## Exit codes

| Code | When |
|---|---|
| 0 | the command ran and nothing failed; or it printed the usage |
| 1 | it ran and found a failure: `check` found a difference; `review` or `deliver` has a failing check; `still --diff` found a frame that depends on history; `handoff --verify` found a different frame; `doctor` is missing something needed; `share` was declined; `share --dry-run` is over a limit; `whoami` is not signed in |
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
  `search`, `info`, `share`, `fork`); `log`: the lines any other command printed.
