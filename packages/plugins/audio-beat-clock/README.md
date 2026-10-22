Measure the song once, then cut every change to its grid: bars, beats, 1/16s, band levels and hits at t.

```sh
node tools/analyze-music.ts audio/song.mp3            # writes audio/song.analysis.json
```

```ts
import { envelope } from './motion/eases.ts'
import { bandsOf, clockFromAnalysis, hitsOf, loadAnalysis } from './music/beat.ts'

// in open
const analysis = await loadAnalysis(host, 'audio/song.analysis.json')
const clock = clockFromAnalysis(analysis)        // { trim } if the film starts later in the song
const bands = bandsOf(analysis)                  // (t) => [sub, low, mid, high], 0–1
const hits = hitsOf(analysis, { strength: 200 }) // strong onsets, in film time

// in render(t)
const drop = clock.at(17)                        // bar 17's downbeat
const flash = envelope(t, hits, { decay: 0.08 }) // 1 on each hit, then falls (motion-eases)
const [sub] = bands(t)
```

The tempo is found by autocorrelation, then fitted to the song's strong onsets on beats, eighths
or sixteenths, whichever they sit closest to, so the grid does not drift over a long song. The
analyser prints how far the onsets sit from it. Listen to check the tempo anyway: if the picture
drifts, the measured BPM may be a ratio of the real one; run again with `--min-bpm`/`--max-bpm`
around what you hear.

The analysis is a `shaderera.analysis/1` artifact of kind `music` (see `docs/analysis.md` in the
`shaderera` package): the song's path and sha256 in `source`, the script and ffmpeg in `tool`,
every setting in `params`. `loadAnalysis` refuses an analysis measured from other bytes than the
song it names, so a replaced song never plays against an old grid. Run the analyser from the
project root, with the song inside the project.

`analysis.sections` holds up to 12 times where the sound changes most (novelty peaks), candidates
for section starts, and `analysis.silences` its quiet stretches, `{ start, end }`. Needs ffmpeg on
PATH.
