Hear a recording, keep the takes that match a description, and land each take's loudest moment on a hit point.

```sh
node tools/listen.ts audio/keys.wav "a single mechanical key press" --top 8 --not "a mouse click"
# writes audio/keys.trims.json
```

```ts
import { clipAt, loadTrims } from './audio/trims.ts'

// in open
const keys = await loadTrims(host, 'audio/keys.trims.json')  // refuses trims of other bytes
const takes = keys.trims.filter((k) => k.rank === 1)

// in audio(): a take per key press, its peak on the press
return presses.map((t, i) => ({ ...clipAt(keys, takes[i % takes.length], t), group: 'fx' }))
```

An agent cannot hear which moment of a recording is the clean key press, or that a whoosh is
loudest 300 ms into its file. This tool hears it with CLAP (`laion/larger_clap_general`,
Apache-2.0), an open model that puts sound and text in one space, run on the CPU by
transformers.js. No Python, no account, nothing leaves the machine.

- **Takes.** `--kind event` (the default) makes one take per onset, from 5 ms before it until it
  has decayed 35 dB, the next onset or 2 s: hits, clicks, steps. `--kind texture` cuts plain
  windows of `--win` seconds for beds and ambiences; crossfade them. At most the 150 loudest
  strokes are heard, about a second each; the model loads in about 10 s.
- **Scores.** `cosine` is CLAP's similarity to your description; compare it between takes of one
  search, not between searches. `rank` is 1 when none of about 45 everyday descriptions, nor any
  you pass with `--not`, fits the take better; otherwise `heardAs` names the one that fits best.
  `z` is how far your description stands above the others.
- **The peak** is the centre of the take's loudest 5 ms. `clipAt` starts the clip earlier by the
  peak's lead, so the loudest moment lands on the hit point; before the film starts, the take
  loses its head instead.
- **The file** is a `shaderera.analysis/1` artifact of kind `sound-trims` (see `docs/analysis.md`
  in the `shaderera` package): the recording's path and sha256 in `source`, the model and its
  pinned revision in `tool`, every setting in `params`. `loadTrims` refuses trims of a recording
  whose bytes changed.

CLAP hears what kind of sound a take is, on single exposed sounds best. It does not judge taste,
and it hears little above about 14 kHz. Listen to the final. The model (about 780 MB) is
downloaded on first use into `~/.shaderera/models`. Needs ffmpeg on PATH. Record each recording's
source and licence (`asset-provenance`).
