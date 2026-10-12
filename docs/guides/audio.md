# Sound

For requests about music, sound design or silence. What sounds right is the film's choice; this
is what the engine does with sound.

- `audio()` returns clips: `{ src, at, from?, to?, gain?, group? }`. A clip is a project file
  placed at `at` seconds of the film; `group` names its stem (`render --stems`). `gain` is a number, or a function of the film's time in seconds: a
  fade, a duck or any envelope is written as code (`docs/protocol.md`, audio).
- `render` and `deliver` measure the mix's loudness (EBU R128: integrated LUFS, true peak, range)
  and report it; `delivery.json` records it. `--loudness=-23` brings the mix to a target by one
  constant gain, with no compression or limiting, and reports the true peak it reached. No target
  is assumed: each placement publishes its own.
- Sound made in code is a clip with `pcm: { sampleRate, channels }` instead of `src`, computed
  in `open` or `audio()` from the seed, and mixed like any file.
- Times taken from music come from measuring the exact file that plays: tempo, beats, onsets and
  band energy (the `audio-beat-clock` item measures and keys them). Listen to check the tempo: a measured
  BPM can be a ratio of the real one.
- A clip that ends while it still sounds stops dead in the export.
- Record every track in `ASSETS.md` (source, licence, sha256). Do not download music unless the
  person asks and the licence allows it. For AI-generated music, record the generator and its
  terms.

Check: review's diagnostics list the clips and how much of the film they cover.
