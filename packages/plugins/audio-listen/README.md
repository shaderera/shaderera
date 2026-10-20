Hear a recording, keep the takes that match a description, and land each take's loudest moment on a hit point.

```sh
node tools/listen.ts audio/keys.wav "a single mechanical key press" --top 8 --not "a mouse click"
# writes audio/keys.trims.json
```

```ts
import { clipAt, loadTrims } from './audio/trims.ts'

// in open
const keys = await loadTrims(host, 'audio/keys.trims.json')  // refuses trims of other bytes
const takes = keys.trims.slice(0, 3)                          // the best three, by cosine
const quietest = Math.min(...takes.map((k) => k.level))

// in audio(): the next take on each press, its peak on the press, matched in level
return presses.map((t, i) => {
  const take = takes[i % takes.length]
  const clip = clipAt(keys, take, t)
  const match = 10 ** ((quietest - take.level) / 20)
  return { ...clip, gain: (s: number) => match * clip.gain(s), group: 'fx' }
})
```

An agent cannot hear which moment of a recording is the clean key press, or that a whoosh is
loudest 300 ms into its file. This tool hears it with CLAP (`laion/larger_clap_general`,
Apache-2.0), an open model that puts sound and text in one space, run on the CPU by
transformers.js. No Python, no account, nothing leaves the machine.

- **Takes.** `--kind event` (the default) makes one take per onset, from 5 ms before it until it
  has decayed 35 dB, the next onset or 2 s: hits, clicks, steps. `--kind texture` cuts plain
  windows of `--win` seconds for beds and ambiences; crossfade them. At most the 150 loudest
  takes are heard (strokes by their peak, windows by their RMS), about a second each; the model
  loads in about 10 s.
- **Scores.** Takes come best first by `cosine`, CLAP's similarity to your description; compare it
  between takes of one search, not between searches. `rank` is 1 when none of about 45 everyday
  descriptions, nor any you pass with `--not`, fits the take better; otherwise `heardAs` names the
  one that does. Near words compete (a whoosh and wind, a click and a key press), so rank 1 is
  strict: read `heardAs`, and name the confusions that matter to you with `--not`.
- **The peak** is the centre of the take's loudest moment, measured over a twentieth of the take
  (5 to 50 ms), and `level` is how loud it is (RMS, dBFS). `clipAt` starts the clip earlier by
  the peak's lead, so the loudest moment lands on the hit point; before the film starts, the take
  loses its head instead. Its `gain` fades the last 20 ms (`{ fade }` to change it), so a tail cut
  while it still rings does not click. Alternate a few takes and match their levels: one take on
  every hit repeats like a machine gun.
- **The file** is a `shaderera.analysis/1` artifact of kind `sound-trims` (see `docs/analysis.md`
  in the `shaderera` package): the recording's path and sha256 in `source`, the model, its pinned
  revision and each weight file's sha256 in `tool`, every setting in `params`. `loadTrims`
  refuses trims of a recording whose bytes changed.

CLAP hears what kind of sound a take is, on single exposed sounds best. It does not judge taste,
and it hears little above about 14 kHz. Listen to the final. The model (about 780 MB) is
downloaded on first use into `~/.shaderera/models`. Needs ffmpeg on PATH. Record each recording's
source and licence (`asset-provenance`).
