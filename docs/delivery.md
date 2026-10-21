# Delivery

What Shaderera hands over, what each output is for, and what was measured. Every output is
rendered from a job ([cli.md](cli.md#versions-and-jobs)), whose `delivery` holds the format,
quality and colour and what was asked of the file (`bitrate`, `maxrate`, `editList`, `stems`,
`bits`). The flags are in [cli.md](cli.md#render).

| Output | Command | For |
|---|---|---|
| Review mp4 | `shaderera render`, a job with `quality: review` | sharing a cut for comments |
| SDR delivery mp4 | a job with `quality: master` | web, social and broadcast-SDR placements |
| ProRes mov | `--format prores-hq` or `prores-4444` (`render`, `job`, `deliver`) | an agency, editor or overlay (4444 keeps alpha) |
| PNG + WAV finishing handoff | a job with `format: png` (`shaderera job --png [--bits 16]`, then `render --job`) | an editor, colourist or online suite |
| Batch | `shaderera deliver` | every variant × locale, each checked for its placement |
| Handoff | `shaderera handoff <job>` | someone else re-rendering the job later |

## The mp4: tested SDR BT.709

Every mp4 (CLI `render`, MCP `render`, `deliver`) is encoded with:

```
-f rawvideo -pix_fmt rgba -s WxH -r FPS -i -
-vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv
-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
-c:v libx264 -preset medium -crf 18        (master: -preset slow -crf 12)
-movflags +faststart   [-c:a aac -b:a 192k -ar 48000 -ac 2]
```

The audio is AAC at 48 kHz stereo, whatever the clips' own rate, as YouTube asks and the WAV
handoff is. `--no-audio` leaves the stream out.

### Colour

The composited frame is 8-bit sRGB. sRGB and BT.709 share primaries. The matrix and range
conversion is explicit and the file says what it is, so a player decodes it with the matrix it was
encoded with. (`setparams` is needed: ffmpeg 8's `scale` otherwise leaves primaries and transfer
unset on the frames, and the encoder writes only the matrix.) A host with a GPU hands ffmpeg
yuv420p that it matted and converted itself, with the same matrix and range, and ffmpeg only tags
it.

**Transfer: a policy, not a conversion.** The sRGB code values are carried unchanged as Y'CbCr,
and the file is tagged with the BT.709 transfer because that is the SDR video convention web,
social and editing players expect. sRGB's curve and BT.709's (or BT.1886's 2.4 display gamma) are
not the same function, so what a viewer sees depends on how its player treats that tag. A grey
ramp (0, 17 … 255) encoded and decoded back:

| Player path | Grey ramp back |
|---|---|
| ffmpeg decode (matrix and range only, no colour management) | within 1 level of the source |
| Chrome 154, headless, Windows: `<video>` drawn into an sRGB 2D canvas | within 1 level, whether tagged BT.709, sRGB or untagged |
| Safari or QuickTime on macOS; a broadcast monitor (BT.1886) | not measured: these interpret the BT.709 transfer by their own rules, so midtones can display differently from Chrome |

So in Chrome the delivered mp4 looks as the host composited it. For a colourist or an online
suite, the PNG handoff (sRGB-tagged frames) is the reference, not the mp4.

`apps/cli/src/deliver/color.test.ts` encodes a 128×128 chart of 16 sRGB patches (greys
0/32/64/128/192/224/255, R, G, B, C, M, Y, light and dark skin, a saturated orange) through the
real ffmpeg path, checks the tags with ffprobe, decodes back with the matrix and range the tags
state (BT.709 limited when untagged, as players assume for HD) and compares patch centres:

| Path | Worst patch (levels, max channel) | Tolerance asserted |
|---|---|---|
| Before: swscale's default matrix (BT.601), no tags | **40** (green 255→215); magenta 37, cyan 26, red 23, yellow 17, blue 14, orange 6, light skin 3 | — (asserted > 10) |
| Now, review (crf 18) | 2 (cyan, magenta, yellow, orange, dark skin); greys exact | ≤ 4 |
| Now, master (crf 12) | 2 (same patches); greys exact | ≤ 3 |

ffmpeg 8.1.1 (gyan.dev full build), Windows 11. The remaining 1–2 levels are 8-bit Y'CbCr
quantisation at limited range, not the encoder: review and master measure the same on flat patches.

### Quality and encoders

| Quality | x264 | a 3D product film, 1920×1080, 14 s, 30 fps | a type film on a still ground, 1080×1920, 8 s, 30 fps |
|---|---|---|---|
| review | crf 18, preset medium | 7.55 MB, 4.3 Mb/s | 390 kB, 0.39 Mb/s |
| master | crf 12, preset slow | 14.70 MB, 8.4 Mb/s | 583 kB, 0.58 Mb/s |

crf is constant quality: bitrate follows the content. A review encode uses NVENC (NVIDIA's H.264
on the GPU, p5 hq, cq 19) where ffmpeg and the machine take the frame size; a master always uses
x264. On the product film with 4 hosts, NVENC took 9.8 → 7.7 s, and its file was about 50%
larger at a like quality (PSNR 46.9 dB against the x264 file, same mean luma).
Whether NVENC takes a size is a test encode, kept in `~/.shaderera/nvenc.json` for that ffmpeg
(its path, mtime and version); `shaderera doctor` asks again. When NVENC then fails on a kept
yes, the yes is dropped and the render runs again once with x264, with a warning.

### Rate control

A placement with a bitrate rule asks for one. `--bitrate 15M` encodes at a constant rate with HRD
filler (`nal-hrd=cbr`), so the floor holds on a still frame, as CTV networks ask: a static 256×64
ramp came out at 1.91 Mb/s for `--bitrate 2M` (x264; NVENC 1.81), where crf gives 0.2.
`--maxrate 10M` keeps the crf and caps it (`-maxrate`, `-bufsize` twice the rate), as DOOH screens
ask. `deliver` records each file as ffprobe reads it (`probe`).

### Loudness

Every output with audio is measured with ffmpeg's `ebur128` (ITU-R BS.1770): integrated loudness,
true peak and range, printed by `render`, recorded in `delivery.json` (`audio.loudness`) and in a
batch's index, and reported by review as a diagnostic. Nothing is judged against a target, because
targets belong to placements (-23 LUFS EBU R128, -24 LKFS ATSC A/85; social platforms publish
none). `--loudness=<LUFS>` on `render`, `deliver` or `assemble` moves the mix by one constant gain
to that integrated loudness, measured on the mix first; measured on 2026-10-12 to land on -16.0
and -23.0 LUFS exactly. It never compresses or limits, so the mix keeps its shape, and the true
peak it reaches is reported for the person to judge.

### Edit lists

By default the mp4 carries an edit list per track: the video's for B-frame reordering, the
audio's for AAC priming. Meta's Reels ads page asks for files without them. `--no-edit-list` (on
`render`, `job` and `deliver`) writes none and keeps the sound on the picture in every player: the
video gets negative composition offsets (`-movflags negative_cts_offsets`), so its first frame is
at 0, and the mix loses its first 1024 samples (21.3 ms), the AAC priming. That cut is the cost,
and why it is not the default: a hit on frame 0 loses its first 21 ms. Measured on 2026-10-12 with
a beep placed at 0.500 s (onset found at 0.50056 s in the source mix):

| File | A player that honours edit lists | One that ignores them |
|---|---|---|
| default mp4 | picture at 0, beep at 500.56 ms | picture 2 frames late (66.7 ms at 30 fps), beep at 521.90 ms |
| `--no-edit-list`, x264 or NVENC | picture at 0, beep at 500.56 ms | picture at 0, beep at 500.56 ms |
| plain `-use_editlist 0` (not used) | picture 66.7 ms late, beep 21.3 ms late | the same |

## ProRes

`--format prores-hq` writes ProRes 422 HQ (`prores_ks` profile 3, `yuv422p10le`), matted over
black; `--format prores-4444` writes ProRes 4444 (profile 4, 4:4:4 with a 16-bit alpha plane,
straight alpha as ProRes keeps it; only 4444 and 4444 XQ carry alpha). Both go in a mov with 48
kHz 24-bit PCM, the same BT.709 matrix, range and tags as the mp4. The vendor field is ffmpeg's
own, not Apple's `apl0`: a QC tool that insists on `apl0` flags it. ProRes 422 HQ is the usual
agency master (DNxHR HQX in Avid shops); H.264 is a terminal file nobody re-edits or re-grades
(The Post Flow delivery cheat sheet, 2026-08-24). Where every host composites on the GPU, ffmpeg
gets the frames at 16 bits a channel (`rgba64`, from the compositor's half-float accumulator),
otherwise at 8.

What the 16 bits buy was measured on 2026-10-12: an `rgba32float` layer ramping red from 0.4 to 0.6
across 256 px, the widest band of one value in the decoded row:

| File | Widest band |
|---|---|
| H.264 mp4 (8-bit 4:2:0) | 12 px |
| ProRes HQ from 8-bit frames | 6 px |
| ProRes HQ from 16-bit frames | 4 px |
| ProRes 4444 from 16-bit frames | 3 px |

An 8-bit layer (a canvas, bytes) alone gains nothing from 16 bits; float textures and layers
blended over each other do.

## Stems and captions

A clip may name a `group` (`dialogue`, `music`, `fx`). `--stems` writes one WAV per group beside
the file (`<name>.stems/<group>.wav`; in a png handoff, `stems/`), each mixed with the same gains
and the same `--loudness` gain as the full mix, so the stems sum to it (tested to 1e-5). Clips
without a group go to `ungrouped`.

Captions (`captions()`, [protocol.md](protocol.md#captions)) are written as `<name>.srt` and
`<name>.vtt` beside every export (in a png handoff, `captions.srt` and `captions.vtt`), cut to the
export window. Every caption needs a finite start before its end: an export refuses an LRC cue's
last line, whose `end` is `Infinity` (`text-timed-cues`), so give it an end first.

Review measures the sidecar in its `captions` check and the `captions` diagnostics, since much
viewing is muted. For each caption:

- characters per second: grapheme clusters, spaces included, line breaks not;
- duration, and the gap to the next caption (negative when they overlap);
- line count and the longest line, in grapheme clusters, so a Thai syllable with its vowel and
  tone marks counts once;
- the other captions it overlaps, by number.

Review, render and the SRT number captions the same way. A caption's number is its cue number in
the full-length SRT: the captions with text, in order of start (ties in `captions()` order), from
1. A blank caption, which no sidecar carries and review does not judge, and a caption every export
refuses are named by their place in `captions()` instead, from 1: `item 4 of captions()`.

Nothing is judged unless requirements.json declares limits (decision 0011):

```json
{ "version": 1, "captions": { "maxCps": 17, "maxLineChars": 42, "maxLines": 2, "minDuration": 0.833, "minGap": 0.083 } }
```

Only the keys set are judged, and each fails just the captions over it. The numbers in the example
are a common broadcast style, not a default: take them from the placement's spec. A caption every
export refuses (no finite start or end, or an end before its start) fails the check always,
declared or not.

## The finishing handoff (PNG + WAV)

A job with `delivery.format: 'png'` renders to `out/<job>/` (`deliver`:
`out/deliveries/<batch>/<job>/`):

- `frames/000000.png …`: 8-bit RGBA (16-bit with `--bits 16`, from the GPU compositor),
  **straight alpha**, sRGB chunk, one per frame `from + i/fps`. A source with a transparent ground
  delivers transparent pixels. Written by a small deterministic PNG encoder (not a canvas, which
  would premultiply and lose low-alpha colour), so the same pixels always give the same file.
- `audio.wav`: 48 kHz, 24-bit PCM, stereo, the source's clips mixed over the job window with the
  same trims, delays and gains as the mp4, padded or cut to the window. Omitted when the source has
  no `audio()`.
- `delivery.json` (`shaderera: delivery/1`): job, revision, variant, effective params, seed, width,
  height, fps, from, to, frame count, the rate (`30000/1001` for an NTSC rate), start timecode
  (`HH:MM:SS:FF` of `from`; drop-frame `HH:MM:SS;FF` at 29.97 and 59.94), preroll and textless, the
  colour statement *"8-bit sRGB, straight alpha; display-referred; not scene-linear"*, the audio
  format and loudness, a sha256 per frame file, the review summary (contact sheet, every check's
  status), the host that rendered (`versions.host`: Node or the browser, the adapter, and in Node
  `webgpu`'s version and the device's feature count), how often `render` read the wall clock
  (`clock`), and the Shaderera and ffmpeg versions.
- `review/`: the review's frames and contact sheet.

The delivery is built in `<dir>.partial` and moved into place only after the determinism re-check
passes. Each frame is written under a temporary name and renamed, so a frame file there is always
whole. A run that fails (a host error, audio, review, Ctrl-C) keeps the frames it finished in
`<dir>.partial`, and the error says how many; `render --job` (or the same `deliver`) again
continues from the first frame missing or cut short there, and prints how many frames it rendered
and how many were already there (`--json`: in the envelope's `log`; `deliver`: `framesKept` in
index.json). The frames come out byte for byte as an uninterrupted run's, and the re-check still
renders its samples from the whole window, kept frames included. `<dir>.partial/partial.json`
names the job (its id and bit depth): a `<dir>.partial` of another job, or another revision, is
refused, never continued. A source that fails the re-check loses its frames: they cannot be
trusted to continue from.

## Batch

`shaderera deliver --variants story,square --locales en,th [--png] [--master] --name spring`
saves the project once, creates one job per variant × locale (`spring-story-th`), renders each and
reviews it on its own child with **output-specific requirements**: requirements.json, with
`format` replaced by the output's own width, height, fps and length. Nothing else is assumed:
there is no default safe area, end hold or reading time. A placement's safe area is declared in
requirements.json (`safeArea`, or a placement's), from that platform's current spec.

A locale sets the `locale` param; `shaderera.json` must declare one (and, if it has an `enum`,
list the locale), or the batch is refused before anything renders. The batch writes
`out/deliveries/<batch>/index.json` (`deliveries/1`: per output its file, bytes, size, length,
frames (a png job: and `framesKept`, the frames an earlier failed run left), render time, checks, contact sheet, status, error) and `index.md` (a table, then every
failing check).

A measured run: a Thai type film laid out for 4:5, given two variants it was not designed for
(1080×1920 and 1080×1080, 8 s), and a 3D product film (1920×1080, 14 s):

| Output | File | Render + review | Checks failing |
|---|---|---|---|
| type film, story, review mp4 | 390 kB | 6.7 s render | end-hold (the 8 s cut ends mid-move), text-fit (min margin 5.7 % vs 14 %/20 %) |
| type film, square, review mp4 | 374 kB | 3.9 s render | end-hold, text-fit (min margin −14.8 %: text leaves the frame) |
| type film, square, PNG handoff | 8.9 MB (240 frames) | 14 s total | end-hold, text-fit |
| product film, review mp4 | 7.55 MB | 35 s total (`--trusted`) | end-hold |
| product film, master mp4 | 14.70 MB | 44 s total | end-hold |

The text-fit failures are real: a layout made for 4:5 does not fit those variants, and review says
so per output.

## Placements

A variant can declare the placement it is delivered to, in requirements.json `placements` (keyed
by variant; `main` is the manifest's own format). `deliver` then checks the file it made, as
ffprobe and the file's boxes read it, against every rule the placement declares and nothing else:
container, video codec, width and height (exact or a minimum), aspect, frame rates, length (a range
or spot lengths), bytes, bitrate floor and ceiling, audio required or none, audio codec, sample
rate, channels, integrated loudness and true peak, no edit list (`editList: false`). Its
`safeArea` is what text-fit judges for that output. Each broken rule names the flag that fixes the
file:

```
✗ b-story  …  failing: placement
  placement Meta Reels ads: an edit list (--no-edit-list)
```

The numbers are data the person brings, never defaults: the plugin `format-placement-specs`
holds Meta Reels ads, YouTube 1080p, Amazon Streaming TV, EBU R128, ATSC A/85 and a 2026 DOOH
screen, each with its source and the date it was read, to copy and keep current. A png handoff is a
folder, not a file a placement takes: its placement check is unknown, so a placement on a png
output fails.

## Broadcast: preroll, timecode, textless

The manifest, or a variant, can declare what a broadcast delivery needs around the film:

```json
"variants": {
  "tv": { "preroll": { "seconds": 10, "fill": "source" }, "timecode": "10:00:00:00" },
  "tv-textless": {
    "preroll": { "seconds": 10 },
    "timecode": "10:00:00:00",
    "textless": true,
    "params": { "copy": false }
  }
}
```

UK broadcast, for one, asks for a 10 s clock slate before the spot and a 0 or 5 s freeze after
it (Clearcast Library Technical Specification v1.6, 2024).

- `preroll`: whole frames before the export's first frame, in the mp4 or mov and in a png handoff
  (`frames/000000.png` onward). `fill: 'black'` (the default) is opaque black and silence;
  `fill: 'source'` renders the source at the frame times before 0, so a slate is the film's own
  code (the plugin `format-broadcast-slate` draws a plain clock). The film's t = 0 stays where it
  is: its sound and captions move with the picture. Measured on 2026-10-12: 1 s of preroll at 30
  fps gave 90 frames, frame 29 black and frame 30 the film, and a beep at 0.5 s decoded at 1.5 s.
- `timecode`: where the programme starts. The file's own timecode (mp4 and mov) is that, less the
  preroll: `10:00:00:00` with 1 s of preroll at 30 fps is `09:59:59:00` at the first frame. Without
  it the programme starts at `00:00:00:00`, and a preroll counts back past midnight
  (`23:59:50:00`). Drop-frame (`;`) at 29.97 and 59.94.
- `textless`: a version without text, for localising over. No `copy` is asked of it, and review's
  `textless` check fails it when inspect or the DOM shows text. How the film leaves its text out is
  its own params.

## Rendering a job on several machines

```sh
npx shaderera plan --job spot --chunks 4          # out/spot.plan/plan.json
npx shaderera render --job spot --chunk 0         # on any machine with the project at the job's revision
npx shaderera render --job spot --chunk 1         # …
npx shaderera assemble --plan out/spot.plan       # one encode, with the whole window's sound
```

- `plan` splits the job's frames into chunks of whole frames and fixes the format every host hands
  them over in (yuv420p or 16-bit RGBA from the GPU compositor, else RGBA). It refuses a folder
  (`--out`) that holds another job's plan or chunks, so that plan can still be assembled; the same
  job is planned again in its own folder.
- Each chunk renders, with its own determinism re-check, into a lossless FFV1 file (the bytes the
  host made), recorded with its sha256 and host. Its frames go round `--workers` hosts on that
  machine, as `render`'s do (up to 4 by default; each holds its own memory, so give fewer for a
  heavy film). Where it runs is the person's: machines in the
  team, a cloud with GPUs, a handoff copied anywhere; Shaderera needs no service for it.
- A chunk is claimed before it renders (`<chunk>.claim` in the plan folder), so two machines never
  render one chunk at once: the second is refused, naming who holds it. A claim whose render died
  is taken over (its pid no longer runs here, or it went untouched for 10 minutes), with the
  partial that render left. Ctrl-C removes the chunk's partial and claim.
- `plan --status --plan <dir> [--verify]` says which chunks are done, missing, stale (of another
  job or plan), partial (stopped part way) or claimed (rendering now), with the command that renders each, the frames done
  and the time left ([cli.md](cli.md#plan-render---chunk-assemble)).
- `assemble` refuses a missing or changed chunk, and chunks from different kinds of host (another
  GPU or driver may round pixels differently, and a seam would show) unless `--mixed-hosts`, and
  lists every such problem at once, each with the command that fixes it. It encodes the chunks
  once in order, with the sound, captions, stems, preroll and timecode of the whole window.
- Measured on 2026-10-12: a job rendered in 3 chunks (out of order) and assembled is the same file,
  byte for byte, as the job rendered in one go, for an mp4 and for ProRes 422 HQ and 4444 (the mov
  muxer runs with `+bitexact`, and PCM packets are 1024 samples each). A sequential source renders
  each chunk from its own start, replaying or restoring a checkpoint.
- A png job is already one file per frame: split it into jobs by window instead.
- On Linux, Dawn renders through Vulkan: a container needs `libvulkan1`, and on NVIDIA
  `NVIDIA_DRIVER_CAPABILITIES` must include `graphics` (NVIDIA Container Toolkit docs). `webgpu`
  0.6.2 loads on Ubuntu 22.04 and later.

## Re-rendering only what an edit changed

A frame is a function of the revision and `t`, so after a small edit the frames the edit did not
touch are already rendered, losslessly, in the earlier plan's chunks.

```sh
npx shaderera job --name spot-v2                  # the edited revision
npx shaderera render --job spot-v2 --reuse out/spot.plan --changed 61.5-63,140-141.2
npx shaderera assemble --plan out/spot-v2.plan    # one encode, as usual
```

- `--changed` takes the changed spans in seconds of the film: where the edit may have changed a
  frame. Each widens to whole frames, then forward by the source's lookback
  ([determinism.md](determinism.md#lookback)); for `sequential: true` it reaches the end of the
  window. There is no margin: a dissolve that reaches outside a span is a frame the samples catch.
- `render --reuse` writes a plan of the new job (`--plan <dir>`, by default `out/<job>.plan`) that
  renders each changed span as a chunk on this machine and takes every other frame from the
  earlier plan, cut out of its FFV1 chunks by frame (lossless). The plan records, for each run of
  reused frames, the earlier plan, job and chunk, with the chunk's sha256. A plan that reused
  frames can itself be reused: its frames point to the chunks that were rendered.
- **The sample check.** Before rendering, it renders the first and last frame of every run of
  reused frames, and about one more every 10 s spread over them, from the new revision, and
  compares them byte for byte with the earlier frames. A frame that differs is refused, with its
  frame, its `t` and the unchanged span it is in, and nothing is written. `--fix` instead renders
  the frames around it up to the nearest frames that matched (and forward by the lookback), and
  samples the new boundaries again.
- It refuses an earlier plan of another format or window (frame size, rate, from–to, the frames
  as handed over), and one rendered on another kind of host than this one (another GPU or driver
  may round pixels differently, so every sample would fail), naming both. There is no flag past
  that.
- `assemble` reads the plan as any other: it checks that each reused chunk is still the file of
  the job it names, and builds the sound, captions, stems, preroll and timecode from the new
  revision for the whole window. With the right `--changed`, the file is byte for byte the one a
  full render of the new job gives.
- The samples are a check, not a proof: a change between two samples outside every changed span
  is missed. Give `--changed` from the edit (the diff, the cue that moved), not from a guess.
- Measured on 2026-10-17, on 300 s (7,500 frames at 1080p25) of a finished film with a grade
  change from 330 to 331 s: a full render on one host took 691 s; `render --reuse` (25 frames
  rendered, 34 sampled) took 167 s and `assemble` 171 s, 338 s in all, and the file was the same,
  byte for byte. Each command spent about 100 s opening that film's job, so the saving grows with
  the frames there are to render, and is small for a short window.

## Handoff

`shaderera handoff <job>` writes `out/handoff/<job>/`: the revision's files as a working tree
(never node_modules, out, other revisions or the files that hold secrets, which a revision never
holds: [cli.md](cli.md#versions-and-jobs)), `versions/` with only that revision's objects, its
record and the job, so `npx shaderera render --job <job>` works there unchanged, and
`REPRODUCE.md`: the commands (`npm ci` with a package-lock, else `npm install`), the lock file's
hash, the installed packages the job executes with the sha256 of each, the OS, GPU, Node, ffmpeg
and Shaderera versions measured at handoff, and the asset hashes with a pointer to ASSETS.md when
the revision has one. The project's `.npmrc` is not in it: a clean install from a private registry
uses the recipient's own npm config. A job whose revision holds a secret (saved by an older
Shaderera) is refused: freeze it again with `shaderera job --name <job> --replace`.

**What a job pins.** A job records each installed package its source executes (what the build
imports, everything those depend on, and `webgpu` when installed) as `name@version` → sha256 of
the package's files. Every host checks them before it renders the job, and refuses when one
changed (the same version with different code included) or Shaderera's version differs. The check
pins what the job renders against; it does not install anything. The lock file is what lets
someone else install the same packages. Assets are project files, hashed into the job.

A job also pins the [bakes](protocol.md#bakes) its source reads: each bake's stamp (its inputs'
hash, its folder, and every frame's size and sha256) goes into the job, and so into its id. Making
the job refuses a bake whose stamp was made from other inputs than the job's revision has.
`render --job` and `handoff --verify` check every frame against the job's hashes and refuse a
missing or changed one, naming the bake and the way back: bake it again from the job's revision
(`shaderera restore <revision>`, then `shaderera bake <name>`), or make a new job. A handoff does
not carry the frames (they may be gigabytes, on another drive); its REPRODUCE.md lists each bake,
where its frames were and what makes them.

**Reproducible from a clean install** is stated at the top of REPRODUCE.md and printed: yes only
when the revision carries a lock file and no `workspace:`, `file:` or `link:` dependency. A handoff
without that is not a production handoff, and says so.

`--verify` copies the handoff to a fresh temp folder, links **this project's** node_modules, opens
the job there from its own `versions/` and compares sha256 of five sampled frames with the
project's. That shows the handoff is complete and relocatable against this installation; it does
not show that a clean install reproduces it. On the 3D product film (`--trusted`, a 4.7 MB
handoff), all five matched. `--clean-install` runs the lock file's install in the fresh folder
instead, so the job's package check compares a clean install with what the job froze before any
frame is compared: the test for handing a job to someone else. The tests run both, and the
documented command in a copy of a png job's handoff, comparing every frame hash in
`delivery.json`.

## Higher precision: HDR, scene-linear EXR, AOVs

Shaderera composites display-referred sRGB code values. The GPU compositor accumulates them in half
floats, clamped to 1.0, and can hand them on at 16 bits a channel (ProRes, `--bits 16` PNGs); a
canvas or byte layer is 8-bit to begin with, and **changing the encoder cannot restore precision a
layer never had**. None of it is HDR: an "HDR" tag on an SDR composite would be a lie, and there is
no scene-linear light in it to put in an EXR.

**HDR10 is decided, not built.** [Decision 0023](https://github.com/shaderera/shaderera/blob/main/docs/adr/0023-hdr10-delivery.md)
(decided 2026-10-22) sets out how it will work:
- a film opts in, and its GPU layers declare linear or PQ light in BT.2020;
- 8-bit layers are decoded as sRGB and placed at a graphics white (203 nits by default, after
  ITU-R BT.2408);
- the film keeps its own tone mapping and its own SDR render;
- the master is HEVC Main 10 in an mp4, with the mastering display and MaxCLL/MaxFALL measured
  on the GPU, chroma sited top-left as BT.2100 states;
- ffmpeg 9.0 is needed only for an HDR10 film (SDR stays tested on 8.1.1);
- films that do not opt in do not change.

Until it is built, what follows holds.

What does not exist: scene-linear compositing, an EXR or HDR writer, AOV (depth, normals, mattes)
channels, PQ/HLG transfer. Nor broadcast playout formats (MXF, XDCAM, AVC-Intra, IMF): clearance
houses and post facilities transcode a ProRes master to them (The Post Flow, 2026-08-24). HEVC
is not written today. Its encoders carry patent-pool royalties (Access Advance), but Shaderera
ships no encoder: it drives the person's own ffmpeg, so decision 0023 allows HEVC for HDR10. Scene-linear compositing would be a
protocol change (`over` in linear light), not an encoder setting.

The honest routes today:

1. **The renderer writes its own float output.** A source renders anything internally (WebGPU
   float targets, three.js linear workflow) and, as a trusted source or its own pipeline driven by
   the same t, writes its passes to EXR itself, keyed by the job's frame times. Shaderera's job and
   frame list give the times and the provenance.
2. **An external pipeline** (a DCC or compositor) renders the high-precision master, using the PNG
   + WAV handoff and `delivery.json` as reference and timing.
