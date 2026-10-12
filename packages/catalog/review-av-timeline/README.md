See the sound and the motion of a rendered film: spectrogram, waveform, onsets and picture change on one timeline; every frame around a moment; the picture-to-sound offset in ms.

```sh
npx shaderera render --out out/film.mp4
node tools/av-review.ts out/film.mp4 --at 3.29,8.1,12.45   # the moments that should hit
# t 3.290: sound onset 3.286 (-4 ms), picture peak 3.300 (+10 ms), picture − sound +14 ms (0.8 frames)
```

Then look at `out/av/timeline.png` and each `out/av/at-<t>.png`:
- **Sync:** the red line is the moment; yellow ticks are where the sound hits. The frame where
  the picture changes should sit on a tick. Picture up to about 45 ms after the sound reads as in
  sync; picture before it is noticed sooner, at about 20 ms.
- **Pacing and density:** the lower curve is how much each frame differs from the last. Spikes
  are cuts and hits; a busy band is fast motion; flat stretches are holds. Compare its shape with
  the spectrogram's sections.

An agent cannot hear or watch playback. This turns both into pictures and numbers it can check,
and the person still listens to the final. Needs ffmpeg and ffprobe on PATH, and @napi-rs/canvas
(installed with Shaderera).
