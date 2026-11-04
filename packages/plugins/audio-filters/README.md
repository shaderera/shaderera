Filters and pitch for sound made in code: a one-pole low-pass, the RBJ Audio EQ Cookbook's biquads, a MIDI note's frequency, and a fade that ends a buffer at zero.

```ts
import { biquad, hz, onePole, tailFade } from './audio/filters.ts'

const rate = 48000
const f = hz(57)
const note = new Float32Array(rate / 2).map((_, i) => 0.2 * Math.sin((2 * Math.PI * f * i) / rate))
onePole(note, 2000, rate)
biquad(note, { type: 'peak', freq: hz(81), q: 2, gainDb: 6 }, rate)
tailFade(note, 0.01, rate)
// audio: async () => [{ pcm: { sampleRate: rate, channels: [note] }, at: 1 }]
```

- `onePole(x, cutoffHz, sampleRate)`: a one-pole low-pass, 6 dB an octave, exactly −3 dB at the
  cutoff at any cutoff below Nyquist. `y += 0.05 * (x - y)` is this filter with its cutoff left
  to the sample rate; here the cutoff is in Hz.
- `biquad(x, { type, freq, q, gainDb }, sampleRate)`: `lowpass`, `highpass`, `bandpass` (0 dB at
  `freq`), `notch`, `peak`, `lowshelf` and `highshelf`, with the cookbook's coefficients. `freq`
  is the cutoff, the centre or the shelf's midpoint; `q` is the cookbook's Q: 1/√2
  (`Math.SQRT1_2`) for a flat low-pass or high-pass that is −3 dB at `freq`, and for a shelf of
  slope 1. `gainDb` is the gain at a peak's centre and on a shelf's shelved side (half of it at
  `freq`); `peak` and the shelves need it, and the others refuse it.
- `hz(midi)`: the equal-tempered frequency of a MIDI note, `hz(69)` = 440, `hz(60)` ≈ 261.63.
- `tailFade(x, seconds, sampleRate)`: a linear fade over the last `seconds`, so the buffer ends at
  exactly 0 and a note cut short does not click.

Each works in place on a Float32Array and returns it. A filter starts from silence and keeps its
state across the array it is given, so filter a whole note or bed in one call: called block by
block, each block starts from silence again and clicks. Every parameter is required. A frequency
at or above Nyquist (half the sample rate), a `q` at or below 0 and a missing `gainDb` are
refused with an error, not clamped. The coefficients hold for the whole call: a filter swept over
time is not here.

This is maths only: no oscillator, instrument, reverb or preset, which are each film's taste. The
test measures each filter with sines at 48 kHz against the cookbook: −3 dB at the cutoff, the
peak's centre gain, both sides of the shelves, the notch's depth.
