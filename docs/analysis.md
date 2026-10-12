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
- An adapter is a script the user runs (ffmpeg, a Python model). Each one is optional. A model
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

### Rasters (masks, depth, when an adapter provides them)

- Stored beside the JSON as raw little-endian arrays, one file per frame or one file per clip with
  an index; the JSON states `dtype` (`u8` | `f32`), `channels`, `width`, `height`,
  `rowStride` **in elements**, origin **top-left**, rows downward, and the source frame `t` each
  raster belongs to.
- A mask is `u8` coverage 0–255 in the source frame's pixel grid; the participant maps it to its
  own frame.

### Depth (optional, experimental until calibrated)

- The artifact states `meaning`: `relative-inverse` | `relative` | `metric-distance` |
  `metric-z`, `units` (metres or `none`), and the invalid value (`NaN`).
- Relative depth is never compared with a renderer's depth buffer. Metric depth is compared only
  after the camera intrinsics and the alignment to the render camera are given and tested. The first
  occlusion demonstrations use screen-space masks.

### Artifact identity and provenance

- `format: "shaderera.analysis/1"` and `kind`. A new incompatible format gets a new number, and the
  loader refuses the old one with "rebuild" (no readers for old formats).
- `source`: path, bytes, sha256. The participant checks the hash at open and refuses a mismatch.
- `tool`: script, its tool versions (ffmpeg version string; model name, version and checkpoint
  sha256 for model-backed adapters); `params`: every setting that changes the output.
- Artifacts are project files: saved revisions and jobs freeze them like any asset (their sha256 is
  in `job.inputs.assets`).

### Live input

Analysis takes files only. A live source can be recorded by the user's own tools into the
artifact format above and rendered like footage. Live capture and inference inside `render` are
out of scope: a non-realtime render fed by live input comes out stretched or misaligned
(TouchDesigner users report it on Derivative's forum).
