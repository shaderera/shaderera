Re-pace a narration: its long pauses between words shortened, the ones you name kept, the tempo changed with the pitch kept, and a time map the edit's times follow.

```sh
node tools/voice-repace.ts audio/voice.wav words/voice.json --out audio/voice-paced.wav --keep 18.2
# writes audio/voice-paced.wav and audio/voice-paced.map.json
```

```ts
import { loadTimeMap, pacedTime } from './audio/repace.ts'

// in open
const map = await loadTimeMap(host, 'audio/voice-paced.map.json')  // refuses a map of other bytes

// in render(t), with times written against the original recording
const cut = pacedTime(map, 12.4)   // where 12.4 s of the original falls in the paced file
```

Then play `audio/voice-paced.wav`, and move every time written against the original (cuts, cues,
`text-timed-cues` words) through `pacedTime`. It shortens pauses and changes the speed only: it
does not transcribe, mix, or lay several files on a timeline.

- **The words** come from any file `text-timed-cues` reads with word times: a speech-to-text
  transcript's `words` (Paxa Labs STT), Whisper's segments with words, enhanced LRC. Their times
  are seconds of the recording.
- `--max-pause` (0.3 s) is the longest pause left between two words; a longer one loses its
  middle, with a `--fade` (0.01 s) crossfade at the join. The silence before the first word and
  after the last is left alone.
- `--keep` takes times, in seconds of the original, inside the pauses to leave as they are: a
  reveal, a title's gap.
- `--tempo` (1) changes the speed after the pauses are cut: 0.9 is slower. It needs an ffmpeg
  built with librubberband (`ffmpeg -filters` lists `rubberband`).
- **The map** is a `shaderera.analysis/1` artifact of kind `time-map` (see `docs/analysis.md` in
  the `shaderera` package): `knots` of `[old seconds, new seconds]`, the recording's path and
  sha256 in `source`, every setting in `params`. A removed stretch of pause is two knots at one
  new time. Before the first knot and after the last, time keeps its own length.

Run it from the project root, on a recording inside the project. It writes 48 kHz, 24-bit WAV,
with the source's channels. Needs ffmpeg and ffprobe on PATH.
