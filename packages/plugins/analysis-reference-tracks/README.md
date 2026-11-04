Motion measured from a reference, read as data: one track per element and channel, each value kept at the source time it was measured, and the film says how to fill between samples.

```ts
import { at, loadTracks, track } from './reference/tracks.ts'

// in open
const ref = await loadTracks(host, 'references/hero.tracks.json')  // refuses a changed source file
const x = track(ref, '.hero h1', 'x')                               // { element, channel, unit, samples }

// in render(t): the film maps its time to source time, then reads
const source = t + 0.4
const value = at(x, source, { between: 'linear' })                 // null before the first sample
```

It reads what an analyser measured, and decides nothing: no easing is fitted, no curve smoothed,
no time stretched. A web page capture writes these files, and so will a video tracker; the film
reads every one the same way.

**The data** is a `shaderera.analysis/1` artifact of kind `reference-tracks` (see
`docs/analysis.md` in the `shaderera` package, which lists every field):
- `source` is a file (path, bytes, sha256) or a live page (url, date, viewport, device pixel
  ratio, and each response's sha256); `tool` and `params` say how it was measured;
- `frame` is the source's width, height and pixel ratio;
- `tracks` hold `{ element, channel, unit, samples }`, the samples `[seconds, value]` at the times
  they were taken; a value is `null` where the element was not there;
- `declared` keeps what the source itself declared (a page's keyframes and easing strings) as
  written, never re-derived from the samples;
- `limits` list what the analyser could not make exact, each with `where` and `reason`. Read them
  before you build on a track.

**Reading.**
- `loadTracks(host, path)` refuses another format or kind, a malformed file, and a source file
  whose bytes are not the ones measured. A page has no file to check: its `responses` say what
  was loaded.
- `track(ref, element, channel)` returns one track, or refuses and names what there is.
- `at(track, sourceTime, { between })`: `'hold'` keeps the earlier sample, `'linear'` draws a line
  to the next. Before the first sample it is `null`, at a sample's time that sample's value, and
  after the last the last value, held. Next to a `null` sample, `linear` holds.
- Units are as measured: `deg` stays degrees and `css-px` CSS pixels. Convert in the film.
- Time is the source's. Mapping render time to it (an offset, a speed, cuts) is the film's code.

**Writing**, for an analyser: `tools/reference-tracks.ts` has `tracksJson(doc)`, the bytes to
write, and `fileSource(path, bytes)`. It refuses what `loadTracks` would refuse, orders every key
and track the same way, and rounds a sample's time to a microsecond and its value to 1/10000 of
its unit. The writer adds no differences of its own: whether two captures match is up to the
capture. A field it does not know on a track is kept, after the fixed ones; one at the top is
refused. Any tool that writes the same JSON is an analyser too.
