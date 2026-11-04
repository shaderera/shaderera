Place sound made in code on the film's timeline: a buffer, sounds added at film seconds with a gain and a constant-power pan, seeded noise, a check, and core's Pcm.

```ts
import { add, check, mixBuffer, noise, toPcm } from './audio/mix.ts'

// in open or audio(): the film's sound, made once
const sr = 48000
const buf = mixBuffer({ duration: manifest.duration, sampleRate: sr, channels: 2 })
const hiss = noise(host.seed)
const hit = Float32Array.from({ length: sr / 4 }, (_, j) => hiss() * Math.exp((-j / sr) * 30))
for (let bar = 1; bar <= 8; bar++) add(buf, hit, clock.at(bar), { gain: 0.5, pan: 0 })
add(buf, hit, clock.at(4, 2), { gain: 0.3, pan: -0.6 })
console.log(check(buf)) // { peak, nonFinite, dc: [left, right] }

audio: async () => [{ pcm: toPcm(buf), at: buf.start, group: 'music' }]
```

- `mixBuffer({ duration, sampleRate, channels, start })`: silence covering `[start, start + duration)`
  of the film (`start` 0 unless given), one or two channels. Return it with `at: buf.start`.
- `add(buf, samples, at, { gain, pan })`: mono samples, the first at film second `at`, rounded to
  the nearest sample. `pan` is -1 (left) to 1 (right), constant power: each side is
  `sqrt((1 ∓ pan) / 2)` of the gain, so -3 dB each at the centre and the whole gain on one side at
  ±1. A sound that sounds as loud panned as centred needs no change in gain. A mono buffer takes
  the gain alone. Samples before or after the buffer are dropped. Gain and pan have no defaults.
- `noise(seed)`: a function that gives the next white-noise value in [-1, 1) on each call, the
  same run for the same seed. It is `motion-random`'s `stream`, which this plugin requires. Fill a
  buffer with it once (`Float32Array.from({ length: n }, noise(7))`) and index that, or draw from
  it in order; never in `render`.
- `check(buf)`: the peak (largest finite |sample|), how many samples are NaN or ±Infinity, and each
  channel's DC offset. It changes nothing: the film decides what to do with a peak over 1.
- `toPcm(buf)`: core's `Pcm`, `{ sampleRate, channels }`.

Times come from the film: from `audio-beat-clock`'s `clock.at(bar, beat)` when the sound follows a
grid, not a bar length written into the synth. Nothing here normalizes, limits, compresses or adds
reverb: scale the mix yourself, by `check(buf).peak` if that is what the film wants.

pcm is held in memory several times on its way to the mix (384 kB a second of stereo at 48 kHz);
for a bed of a minute or more, render it to an audio file once instead, as
[the protocol](https://github.com/shaderera/shaderera/blob/main/docs/protocol.md) says.
