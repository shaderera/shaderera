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
  features it was shown with, whether it was a `mobile` page and what started the motion
  (`trigger`); its pixel ratio is `frame.pixelRatio`. A setting the analyser gives a default is a
  constant, recorded like any other, never the machine's.
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
  a sample's time it is that value. Between samples the data says nothing: the film fills as it
  chooses (the `analysis-reference-tracks` reader offers `hold` and `linear`, and next to a
  `null` sample there is no line, so its `linear` holds the earlier value until the `null`; any
  other fill is the film's own code over `samples`). After the last sample the data does not say
  whether the source stopped there or the measurement did, so the film chooses again (that
  reader offers `hold`, the last value, or `none`, `null` as the [Time](#time) contract gives).
  The reader has no default for either, since each changes a frame.
- **The bytes are stable.** Keys in one order, tracks sorted by element then channel, a page's
  responses by url, times rounded to a microsecond and values to 1/10000 of their unit. The
  writer adds no differences of its own; whether two captures of the same motion match is up to
  the analyser.
- A reader keeps fields it does not know. A field that changes what a sample means is an
  incompatible change: a new kind or format number.

### Reference style

The still facts of a reference at one moment, so a film can copy a page's look one to one: each
element's box and the computed styles that change how it is drawn, each text node's line boxes
and the fonts it was drawn with, and a screenshot. Kind `reference-style`; the
`analysis-web-capture` plugin writes it (`--still`) and reads it (`loadStyle`). A
`reference-tracks` reader refuses it, and its reader refuses a `reference-tracks` artifact.

```json
{
  "format": "shaderera.analysis/1",
  "kind": "reference-style",
  "source": { "url": "https://example.com/", "date": "2026-11-04T09:00:00.000Z", "viewport": { "width": 1280, "height": 720 }, "devicePixelRatio": 1, "responses": [] },
  "tool": { "script": "tools/capture-web.ts", "version": "0.3.0", "chrome": "Chrome/156.0.8078.80" },
  "params": { "still": 500, "root": ":root", "styles": ["font-family", "color"], "rafHz": 60 },
  "frame": { "width": 1280, "height": 720, "pixelRatio": 1 },
  "scroll": { "x": 0, "y": 0 },
  "screenshot": { "path": "style.png", "width": 1280, "height": 720, "sha256": "9c1e…" },
  "elements": [
    {"element": "[data-id=\"card\"]", "dataId": "card", "tag": "div", "box": [40, 60, 320, 200], "paintOrder": 2, "styles": {"font-family": "Inter, sans-serif", "color": "rgb(0, 0, 0)"}}
  ],
  "texts": [
    {"element": "[data-id=\"card\"] > p", "child": 0, "text": "สวัสดี", "boxes": [{"box": [64, 132, 70.5, 32], "start": 0, "length": 6}], "fonts": [{"familyName": "Thonburi", "postScriptName": "Thonburi", "isCustomFont": false, "glyphCount": 4}]}
  ],
  "fontFaces": [{ "fontFamily": "Inter", "src": "https://example.com/inter.woff2" }],
  "limits": []
}
```

- `source`, `tool` and `frame` are as for `reference-tracks`. `tool` records the browser's
  version: the protocol a page analyser reads these facts with can change between versions.
  `params` holds every setting that changed the facts: the moment (`still`, in ms on the page's
  clock), the `root` whose subtree was read, the `styles` read, and the clock and trigger
  settings, as for a page's tracks.
- `scroll`: the window's scroll at the moment, in CSS pixels. Boxes are from the viewport's top
  left, so a box plus the scroll is its place on the page.
- `screenshot`: the frame as drawn, a PNG file beside the artifact (a name, not a path), its size
  in device pixels and its sha256. The reader refuses other bytes.
- `elements`: each element (and each pseudo-element, with `pseudoElement`, such as `::after`) laid
  out under the root, in document order.
  - `element` names it as a CSS selector that finds it: `[data-id="…"]` or `#id` when unique,
    else its path from the root of its tree. `dataId` is its `data-id`, when it has one.
  - `box`: `[x, y, width, height]` in CSS pixels, as drawn, after transforms.
  - `paintOrder`: the browser's; a higher one is drawn later, over a lower one.
  - `styles`: each name in `params.styles`, as the browser computed it, a string as CSS writes it
    (`"rgba(0, 0, 0, 0.25) 0px 12px 32px 0px"`). The list is open: a capture can read more.
- `texts`: each text node under the root that has a line box, in document order: the `element`
  that holds it (named as in `elements`), its `child` index there, its `text` as laid out (white
  space collapsed, case transformed), `boxes`, one per line fragment with the UTF-16 range of
  `text` it holds, and `fonts`, every font its glyphs were drawn with: `familyName`,
  `postScriptName`, `isCustomFont` (a web font, not a system font) and `glyphCount`. A fallback is
  a font of its own here, so a line the page's font has no glyphs for shows which font drew it.
- `fontFaces`: each web font the page loaded, as the browser reports it, sorted. Fonts are named,
  never copied: a `data:` source is kept as its media type only, a `blob:` one as its origin.
- `limits`: as for `reference-tracks`, without times. Pixels the facts cannot say (a canvas, a
  video, an iframe's document, the text of a form control the browser draws) are a limit; they
  are in the screenshot only.
- **The bytes are stable.** Keys in one order, elements and texts in document order, one per
  line, a text's fonts sorted by family, boxes rounded to a millionth of a pixel. Two captures of
  the same page differ only in `source.date` and in what the site served.
- A reader keeps fields it does not know. Nothing in it is a choice: a film reads what was drawn
  and decides in its own code what to copy.
- Every field above is required, as a live page gives them all. A source that cannot give one (an
  image read by OCR has no paint order, scroll or platform fonts) changes the kind under a new
  format number; it does not make one up.

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
  then explained. A page's motion also records `fonts`: for each tracked element whose text was
  drawn at the first frame, its `element` and the `fonts` its glyphs were drawn with then, as for
  a [still](#reference-style)'s texts (`familyName`, `postScriptName`, `isCustomFont`,
  `glyphCount`), sorted by family. A system font the page fell back to is one of them, so boxes
  that differ on another machine are explained.
- `tool`: script, and the name and version string of every program that produced the samples
  (ffmpeg, the browser a page was captured in, a model's name, version and checkpoint sha256);
  `params`: every setting that changes the output.
- Artifacts are project files: saved revisions and jobs freeze them like any asset (their sha256 is
  in `job.inputs.assets`).

### Regions (still image)

Named parts of one image, which `still --compare-file <image> --regions` scores apart
([cli.md](cli.md#measuring-against-a-reference-image)). Any analyser, or a person's script, may
write them; a file of boxes is the hand-written form.

- **Regions:** a `regions.json` artifact of `kind: "regions"`. `source` is as above, with the
  image's `width` and `height` in pixels; a reader refuses another image's sha256 or size.
  `regions` is a list, each with an `id` (a string, unique in the file), an optional `label`,
  and a `mask` as [Rasters](#rasters-masks-depth-when-an-analyser-provides-them) defines one
  (`dtype: "u8"`, `channels: 1`, `width`, `height`, `rowStride`, `at`), in the image's pixels.
  `mask.file` is the raster's file name, beside `regions.json`: a bare name, never a path.
- **Boxes:** a JSON file of `format: "shaderera.boxes/1"` (it may be left out: a file without
  `format` is this one), `width` and `height` (the pixels the boxes are in: the image's or the
  film's frame's), and `boxes`, a list each with a `name` (unique in the file) and `x`, `y`,
  `width`, `height` in whole pixels, width and height 1 or more. A box partly outside the frame
  counts where it is inside. Another `shaderera.boxes/` version is refused.
- In either, a field a reader does not know is ignored, so a writer may add its own (a score, a
  box, a parent).

### Live input

Analysis takes files, or a live web page that an analyser captured, with what the page loaded
recorded as its `source`. Any other live source can be recorded by the user's own tools into the
artifact format above and rendered like footage. Live capture and inference inside `render` are
out of scope: a non-realtime render fed by live input comes out stretched or misaligned
(TouchDesigner users report it on Derivative's forum).
