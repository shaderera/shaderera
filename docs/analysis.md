# Analysis: footage and sound as frozen data

A film reacts to footage and sound by reading ordinary data. An analysis script, run once and
apart from rendering, turns a clip or a track into measurements and events; the film's code reads
them as a function of render time. This page defines that data, the `shaderera.analysis/1`
format, and the rules that keep a reaction deterministic.

## Principles

- Creative code stays the source of truth. Analysis produces **data** (JSON, raw arrays); the
  participant decides what it means on screen.
- Analysis runs **apart from rendering**. Render and export read frozen artifacts and never start
  inference. Core installs no model, needs no account and no vendor runtime.
- Shaderera owns time alignment, artifact identity, failure and replay. It does not own a
  perception graph, a model registry or an inference framework.
- An analyser is a script the user runs (ffmpeg, a Python model). Each one is optional. A model
  is the user's own download, recorded with its version, checksum and licence.

## Contracts

### Time

- Every measurement carries **source time** in seconds on its source's own timeline: the decoder's
  presentation time for video frames, `sample / sampleRate` for audio. Frame indexes are never the
  key; variable frame rate is kept, not resampled.
- A video measurement is valid from its `t` until the next frame's `t` (sample and hold); before
  the first and after the last frame's end there is none (`null`).
- Render time maps to source time by the participant's own code. The slice uses
  `source = t + offset`; retiming (speed, cuts) is participant code too.
- Signals that must align (frames, landmarks, masks, audio events) are aligned by source time, each
  with its declared bound (an onset's window; a frame's hold).

### Events

- An event has a stable `id` and a `t`. Effects use **time and age** (`age = t_now − t_event`)
  or consume events **by id**, never "did an event happen near now": a frame computed out of order,
  repeated or skipped shows the same effect. (The `nearBeat(t)` + `emit()` pattern double-fires on
  repeats and misses events between frames.)
- A sequential participant that must spawn state per event spawns it when its step crosses the
  event's time (`prev < t_event ≤ now`); replay ([sequential sources](determinism.md#pure-and-sequential-sources)) makes that deterministic.

### Rasters (masks, depth, when an analyser provides them)

- Stored beside the JSON as raw little-endian arrays, one file per frame or one file per clip with
  an index; the JSON states `dtype` (`u8` | `f32`), `channels`, `width`, `height`,
  `rowStride` **in elements**, origin **top-left**, rows downward, and the source frame `t` each
  raster belongs to (none for a still image).
- A mask is `u8` coverage 0–255 in the source frame's pixel grid, over the whole frame or over a
  rectangle of it whose top-left `at: [x, y]` the JSON states; the participant maps it to its own
  frame.

### Depth (optional, experimental until calibrated)

- The artifact states `meaning`: `relative-inverse` | `relative` | `metric-distance` |
  `metric-z`, `units` (metres or `none`), and the invalid value (`NaN`).
- Relative depth is never compared with a renderer's depth buffer. Metric depth is compared only
  after the camera intrinsics and the alignment to the render camera are given and tested. The first
  occlusion demonstrations use screen-space masks.

### Reference tracks

Motion measured from a reference (a web page, a clip), so a film can copy it one to one. Kind
`reference-tracks`; every analyser that measures motion writes it, and a film reads it through
one reader (the `analysis-reference-tracks` plugin, whose writer the analysers share).

```json
{
  "format": "shaderera.analysis/1",
  "kind": "reference-tracks",
  "source": { "path": "references/hero.mp4", "bytes": 5120331, "sha256": "4be1…" },
  "tool": { "script": "tools/track.ts", "version": "0.1.0" },
  "params": { "fps": 30 },
  "frame": { "width": 1920, "height": 1080, "pixelRatio": 1 },
  "tracks": [
    { "element": "title", "channel": "x", "unit": "source-px", "samples": [[0.4, 120], [0.433333, 131.5]] }
  ],
  "declared": [],
  "limits": [{ "where": "title", "reason": "motion blur hides its left edge", "from": 0.4, "to": 0.6 }]
}
```

- `source` is a file or a live page, as [below](#artifact-identity-and-provenance). `params` holds
  every setting that changed the samples: for a page capture the fps, `rafHz`, the seed, what the
  page's clocks read when the capture froze them (`timeOrigin`, `clockDate`, `timezone`), when it
  froze them (`settle`), the `locale` its `Intl`, language and `Accept-Language` saw, the `media`
  features it was shown with and what started the motion (`trigger`); its pixel ratio is
  `frame.pixelRatio`. A setting the analyser gives a default is a constant, recorded like any
  other, never the machine's.
- `frame`: the source's `width` and `height`, in the unit of its position tracks (CSS pixels for a
  page's viewport, pixels for a clip), and `pixelRatio`, device pixels per CSS pixel (1 for a
  clip).
- `tracks`: one per element and channel, each pair once.
  - `element` names it as the analyser does: a CSS selector for a page, a tracker's label. A
    page's own scroll position is the element `window`, channels `scrollX` and `scrollY`.
  - `channel` is an open set. Common names: `x`, `y`, `width`, `height` (the box as seen, origin
    top-left of the frame, rows downward; for a page, the bounding box after transforms),
    `opacity`, `rotate`, `scaleX`, `scaleY`, `translateX`, `translateY`. Any other channel is named
    for what it measures (`borderRadius`, `--progress`, `color.r`); an analyser says in its README
    how it reads each one.
  - `unit` is an open set too. Common names: `css-px`, `source-px`, `deg`, `ratio` (opacity,
    scale). Values are kept in it, never converted.
  - `samples`: `[source seconds, value]` at strictly increasing times, kept at the times they were
    taken, never resampled. A value is a number, or `null` where the element was not there.
- `declared`: what the source itself declared, kept as written, never re-derived from the samples:
  for a page each animation's keyframes, timing and easing string. Each entry names its `element`
  and its `type`, an open set named by the analyser (for a page, `css-transition`,
  `css-animation`, `web-animation`); the rest is the source's (a value JSON cannot hold, such as
  infinite iterations, as the source's own language writes it: `"infinite"`), but for `start`: for
  a page, the source second at which the analyser first saw the animation running, as it observed
  it (absent when it did not), so its keyframes can be placed in source time.
- `limits`: what the analyser could not make exact, each with `where` (an element, a URL, a part
  of the source), `reason`, and `from` and `to` in source seconds when it covers only part of the
  time. An empty list means the analyser found nothing it missed, not that nothing was.
- **Reading a sample** is a state, not a frame: before the first sample there is none (`null`); at
  a sample's time it is that value. Between samples the film chooses `hold` or `linear`, and after
  the last it chooses `hold` (the last value) or `none` (`null`, as the [Time](#time) contract
  gives): the data does not say whether the source stopped there or the measurement did. The
  reader has no default for either, since each changes a frame.
- **The bytes are stable.** Keys in one order, tracks sorted by element then channel, a page's
  responses by url, times rounded to a microsecond and values to 1/10000 of their unit. The
  writer adds no differences of its own; whether two captures of the same motion match is up to
  the analyser.
- A reader keeps fields it does not know. A field that changes what a sample means is an
  incompatible change: a new kind or format number.

**`reference-style`** is its own kind, for still facts of a reference (boxes, computed styles,
the fonts each run of text was drawn with). It shares `source` and `frame` with
`reference-tracks` and is defined with its reader; a `reference-tracks` reader refuses it.

### Artifact identity and provenance

- `format: "shaderera.analysis/1"` and `kind`. A new incompatible format gets a new number, and the
  loader refuses the old one with "rebuild" (no readers for old formats).
- `source`: path, bytes, sha256. The participant checks the hash at open and refuses a mismatch.
  A live web page cannot be hashed, so its source is what was loaded instead: `url`, `date`
  (ISO 8601, UTC), `viewport` (`width`, `height` in CSS pixels), `devicePixelRatio` and
  `responses`, each `{ url, status, sha256 }` of a response's body as served (after any
  Content-Encoding is undone). When those bytes were not available, `hashOf` says what was hashed
  instead: `"text-as-utf8"` is the body as the browser decoded it with its charset, encoded as
  UTF-8, which matches the served file only when it was UTF-8. A second capture that differs is
  then explained.
- `tool`: script, and the name and version string of every program that produced the samples
  (ffmpeg, the browser a page was captured in, a model's name, version and checkpoint sha256);
  `params`: every setting that changes the output.
- Artifacts are project files: saved revisions and jobs freeze them like any asset (their sha256 is
  in `job.inputs.assets`).

### Live input

Analysis takes files only. A live source can be recorded by the user's own tools into the
artifact format above and rendered like footage. Live capture and inference inside `render` are
out of scope: a non-realtime render fed by live input comes out stretched or misaligned
(TouchDesigner users report it on Derivative's forum).
