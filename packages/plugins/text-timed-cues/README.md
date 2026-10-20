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
