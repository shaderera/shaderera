Lyrics and subtitles by time: read LRC, SRT, WebVTT, Whisper or STT JSON once, then ask for the line and the word at t.

```ts
import { cueAt, loadTimedText, wordAt } from './type/timed-text.ts'

// in open
const lyrics = await loadTimedText(host, 'lyrics/song.lrc')  // .lrc, .srt, .vtt or .json; { trim } if the film starts later

// in render(t)
const line = cueAt(lyrics, t)    // { start, end, text, words? }, or undefined between cues
const word = wordAt(lyrics, t)   // { start, end, text }: the word being sung, when the file has words
```

It gives times only: how a line looks and moves is the film's code.

- LRC: `[mm:ss.xx] line`, several stamps on a line for a repeated line, enhanced LRC's
  `<mm:ss.xx>` before each word, and `[offset:+250]` (ms; a positive offset makes every time
  sooner). A line ends where the next starts.
- SRT and WebVTT: `start --> end` blocks; tags such as `<i>` are stripped. No styling or positions
  are read.
- JSON: rows of `[start, end, "line"]`, cues like the ones `cueAt` returns, Whisper's
  `segments` with `words` (an aligner's output, for word times), or a speech-to-text transcript's
  top-level `words` of `{ start, end, text }` (Paxa Labs STT). A transcript is one cue, from its
  first word to its last, with its `text`; `wordAt` gives the words.
- `parseLrc`, `parseSrt`, `parseTimedJson` and `parseTimedText(path, source)` read text you already
  have; `trimCues(cues, s)` shifts every time by `-s`.

## As the film's captions

A `Cue` is already a `Caption`, so `captions()` can return the cues as they are, and every export
writes them as SRT and WebVTT sidecars. Only an LRC's last line needs one thing first: its `end` is
`Infinity`, which review fails and the exports refuse, so end it with the film:

```ts
// in the source
async captions() {
  const end = host.manifest.duration
  return lyrics.filter((c) => c.start < end).map((c) => ({ ...c, end: Math.min(c.end, end) }))
}
```

Review measures the captions (characters per second, duration, gap, lines, overlaps) but judges
them only against the limits `requirements.json` declares, such as
`{ "version": 1, "captions": { "maxCps": 17, "maxLines": 2 } }`; see the `shaderera` package's
`docs/delivery.md`, Stems and captions.
