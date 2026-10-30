# Sound

For requests about music, sound design or silence. What sounds right is the film's choice; this
is what the engine does with sound.

- `audio()` returns clips: `{ src, at, from?, to?, gain?, group? }`. A clip is a project file
  placed at `at` seconds of the film; `group` names its stem (`render --stems`). `gain` is a number, or a function of the film's time in seconds: a
  fade, a duck or any envelope is written as code (`docs/protocol.md`, audio). A src with no
  audio stream (a video without sound) is silence, left out of the mix; a src that cannot be read
  fails the render, naming the clip.
- `render` and `deliver` measure the mix's loudness (EBU R128: integrated LUFS, true peak, range)
  and report it; `delivery.json` records it. `--loudness=-23` brings the mix to a target by one
  constant gain, with no compression or limiting, and reports the true peak it reached. No target
  is assumed: each placement publishes its own.
- Sound made in code is a clip with `pcm: { sampleRate, channels }` instead of `src`, computed
  in `open` or `audio()` from the seed, and mixed like any file.
- Times taken from music come from measuring the exact file that plays: tempo, beats, onsets and
  band energy (the `audio-beat-clock` plugin measures and keys them). Listen to check the tempo: a measured
  BPM can be a ratio of the real one.
- A beat grid can also land half a beat off, on the off-beat hats instead of the kicks. Compare
  the low end with the grid over a few bars (the analysis's `sub` band at the beats and halfway
  between them): when the kicks fall between the beats, shift the whole grid by half a beat (in
  `clockFromAnalysis`, `trim` less half of `tempo.period`), then check which beat starts the bar.
- A sound is in sync when it lands on its hit point, and most sounds are loudest some way into
  their file: a whoosh, hundreds of ms. Place a clip by its peak, not its start (the
  `audio-listen` plugin finds takes in a recording with CLAP and measures their peaks).
- A clip that ends while it still sounds stops dead in the export.
- Record every track in `ASSETS.md` (source, licence, sha256). Do not download music unless the
  person asks and the licence allows it. For AI-generated music, record the generator and its
  terms.

## Sound from outside

For sound effects or music from outside the project, when the brief or the person asks for them.
Sound made in code is never the lesser choice.

| Source | Good for | Call | Verified |
|---|---|---|---|
| Openverse | sound effects (Freesound, 590,000), music (Jamendo, 640,000), field and archive recordings (Wikimedia, 4 million) | `api.openverse.org/v1/audio/?q=<terms>&source=freesound&license_type=commercial` (`source=jamendo` for music, `wikimedia_audio`); each result has `url`, `license`, `license_version`, `creator`, `duration` (ms), `attribution`, `foreign_landing_url` | 2026-10-18 |

- No key is needed. Anonymous use allows 20 calls a minute and 200 a day (the
  `x-ratelimit-*` headers say how many are left): search for each kind of sound once and choose
  from the results. `category=sound_effect` returns nothing; choose by `source`.
- `license_type=commercial` keeps CC0, CC BY, CC BY-SA and public domain. Without it most
  Jamendo music comes back CC BY-NC-ND: no ads, and no trim (`footage.md`, Licences).
- A Freesound result's `url` is its high-quality preview, an MP3 (about 170 kbps, 44.1 kHz). The
  original file is in `alt_files`, behind Freesound's own API and its OAuth sign-in. A Jamendo
  `url` is a 192 kbps MP3.
- Check the first bytes of every download: an MP3 starts with `ID3` or `\xFF\xFB`; an HTML page is
  a refusal, not the file.
- Record each kept file with the `asset-provenance` plugin, as for footage (`footage.md`,
  Record): `--source` is `foreign_landing_url`, and `--credit` is `attribution`, as it is.

## Check

Review's diagnostics list the clips and how much of the film they cover. You cannot hear or
watch playback, so turn both into pictures: render the film, then draw the sound (spectrogram,
waveform, onsets) and how much the picture changes every frame on one timeline, with strips of
every frame around each moment that should hit, and measure picture against sound in ms. Judge
sync from those. Then end with the times of the cues worth listening to (the hits, the cuts, a
duck under a voice) for the person to check by ear, and do not say that it sounds right.
