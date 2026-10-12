Measure the song once, then cut every change to its grid; read its lyrics or subtitles and ask for
the line and the word at t.

```sh
node tools/analyze-music.ts audio/song.mp3            # writes audio/song.analysis.json
```

```ts
import { bandsOf, clockFromAnalysis, hitsOf, loadAnalysis, pulse } from './music/beat.ts'
import { cueAt, loadTimedText, wordAt } from './music/timed-text.ts'

// in open
const analysis = await loadAnalysis(host, 'audio/song.mp3', 'audio/song.analysis.json')
const clock = clockFromAnalysis(analysis)        // { trim } if the film starts later in the song
const bands = bandsOf(analysis)                  // (t) => [sub, low, mid, high], 0–1
const hits = hitsOf(analysis, { strength: 200 }) // strong onsets, in film time
const lyrics = await loadTimedText(host, 'lyrics/song.lrc') // .lrc, .srt, .vtt or .json

// in render(t)
const drop = clock.at(17)                        // bar 17's downbeat
const flash = pulse(t, hits, 0.08)
const [sub] = bands(t)
const line = cueAt(lyrics, t)                    // { start, end, text, words? }
const word = wordAt(lyrics, t)                   // the word being sung, when the file has words
```

The tempo is found by autocorrelation, then fitted to the song's strong onsets on beats, eighths
or sixteenths, whichever they sit closest to, so the grid does not drift over a long song. The
analyser prints how far the onsets sit from it. Listen to check the tempo anyway: if the picture
drifts, the measured BPM may be a ratio of the real one; run again with `--min-bpm`/`--max-bpm`
around what you hear.

`loadAnalysis` refuses an analysis measured from other bytes than the song, so a replaced song
never plays against an old grid. Timed text JSON is rows of `[start, end, "line"]`, cues like the
ones `cueAt` returns, or Whisper's `segments` with `words` (an aligner's output, for word times).
Needs ffmpeg on PATH.
