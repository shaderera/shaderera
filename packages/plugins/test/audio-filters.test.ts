// audio-filters, laid out as `add` lays it out. Each filter's steady-state gain is measured with a
// sine at −30 dBFS and 48 kHz (settled, then its amplitude at that frequency over whole cycles)
// against the RBJ Audio EQ Cookbook: −3 dB at the cutoff for the one-pole and for the low-pass and
// high-pass at q = 1/√2, 0 dB at the band-pass's centre, the notch's depth, the peak's centre
// gain, both sides of each shelf and half the gain at its midpoint. And hz, tailFade and the
// refusals.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layOut } from './lay-out.ts'

const load = layOut('audio-filters')
const { biquad, hz, onePole, tailFade } = (await load(
  'src/audio/filters.ts',
)) as typeof import('../audio-filters/src/audio/filters.ts')
type Biquad = import('../audio-filters/src/audio/filters.ts').Biquad

const RATE = 48000
const LEVEL = 10 ** (-30 / 20)
const HALF_POWER = 10 * Math.log10(0.5)

/** The gain in dB at `freq` of a filter applied in place: a sine run through it, measured settled. */
const gainAt = (filter: (x: Float32Array) => void, freq: number) => {
  const settle = Math.round(0.5 * RATE)
  const cycles = Math.max(20, Math.ceil(0.25 * freq))
  const n = Math.round((cycles * RATE) / freq)
  const w = (2 * Math.PI * freq) / RATE
  const x = Float32Array.from({ length: settle + n }, (_, i) => LEVEL * Math.sin(w * i))
  filter(x)
  let re = 0
  let im = 0
  for (let i = settle; i < settle + n; i++) {
    re += (x[i] as number) * Math.cos(w * i)
    im += (x[i] as number) * Math.sin(w * i)
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / n / LEVEL)
}
const bq = (f: Biquad) => (x: Float32Array) => biquad(x, f, RATE)
const near = (got: number, want: number, what: string, eps = 0.02) =>
  assert.ok(Math.abs(got - want) <= eps, `${what}: ${got.toFixed(4)} dB, want ${want.toFixed(4)}`)

test('onePole is −3 dB at its cutoff, near 0 dB far below it and 6 dB an octave above it', () => {
  for (const fc of [100, 1000, 5000, 15000])
    near(
      gainAt((x) => onePole(x, fc, RATE), fc),
      HALF_POWER,
      `onePole ${fc} Hz`,
    )
  near(
    gainAt((x) => onePole(x, 1000, RATE), 20),
    0,
    'onePole 1 kHz at 20 Hz',
  )
  const a = gainAt((x) => onePole(x, 100, RATE), 1600)
  const b = gainAt((x) => onePole(x, 100, RATE), 3200)
  near(a - b, 6, 'onePole 100 Hz, 1.6 to 3.2 kHz', 0.1)
})

test('the low-pass and high-pass at q = 1/√2 are −3 dB at freq and flat in their pass band', () => {
  for (const freq of [100, 1000, 10000]) {
    const lp = bq({ type: 'lowpass', freq, q: Math.SQRT1_2 })
    const hp = bq({ type: 'highpass', freq, q: Math.SQRT1_2 })
    near(gainAt(lp, freq), HALF_POWER, `lowpass ${freq} Hz`)
    near(gainAt(hp, freq), HALF_POWER, `highpass ${freq} Hz`)
    near(gainAt(lp, freq / 10), 0, `lowpass ${freq} Hz a decade below`)
    near(gainAt(hp, Math.min(freq * 10, 20000)), 0, `highpass ${freq} Hz above`, 0.05)
  }
  // 12 dB an octave: a decade above a low-pass's cutoff is about −40 dB.
  near(gainAt(bq({ type: 'lowpass', freq: 200, q: Math.SQRT1_2 }), 2000), -40, 'lowpass slope', 0.2)
})

test('the band-pass is 0 dB at its centre and the notch takes it out', () => {
  near(gainAt(bq({ type: 'bandpass', freq: 1000, q: 4 }), 1000), 0, 'bandpass centre')
  assert.ok(gainAt(bq({ type: 'bandpass', freq: 1000, q: 4 }), 250) < -20, 'bandpass skirt')
  const notch = gainAt(bq({ type: 'notch', freq: 1000, q: 1 }), 1000)
  assert.ok(notch < -80, `notch centre: ${notch} dB`)
  near(gainAt(bq({ type: 'notch', freq: 1000, q: 1 }), 50), 0, 'notch far below', 0.05)
})

test('the peak has its gain at its centre and none far from it', () => {
  for (const gainDb of [12, 6, -9]) {
    const peak = bq({ type: 'peak', freq: 2000, q: 2, gainDb })
    near(gainAt(peak, 2000), gainDb, `peak ${gainDb} dB`)
    near(gainAt(peak, 30), 0, `peak ${gainDb} dB far below`, 0.05)
  }
})

test('a shelf has its gain on its shelved side, half of it at freq and none on the other side', () => {
  for (const gainDb of [9, -6]) {
    const low = bq({ type: 'lowshelf', freq: 500, q: Math.SQRT1_2, gainDb })
    const high = bq({ type: 'highshelf', freq: 4000, q: Math.SQRT1_2, gainDb })
    near(gainAt(low, 20), gainDb, `lowshelf ${gainDb} dB at 20 Hz`, 0.05)
    near(gainAt(low, 500), gainDb / 2, `lowshelf ${gainDb} dB at freq`)
    near(gainAt(low, 20000), 0, `lowshelf ${gainDb} dB at 20 kHz`, 0.05)
    near(gainAt(high, 23000), gainDb, `highshelf ${gainDb} dB at 23 kHz`, 0.05)
    near(gainAt(high, 4000), gainDb / 2, `highshelf ${gainDb} dB at freq`)
    near(gainAt(high, 30), 0, `highshelf ${gainDb} dB at 30 Hz`, 0.05)
  }
})

test('hz is the equal-tempered frequency of a MIDI note', () => {
  assert.equal(hz(69), 440)
  assert.equal(hz(81), 880)
  assert.ok(Math.abs(hz(60) - 261.6255653) < 1e-6, `hz(60) = ${hz(60)}`)
})

test('tailFade ends a buffer at exactly 0 without a click', () => {
  const w = (2 * Math.PI * 440) / RATE
  const x = Float32Array.from({ length: RATE / 10 }, (_, i) => LEVEL * Math.sin(w * i + 0.7))
  const before = x.slice()
  const out = tailFade(x, 0.02, RATE)
  assert.equal(out, x, 'in place')
  assert.equal(x[x.length - 1], 0)
  const fade = 0.02 * RATE
  for (let i = 0; i < x.length - fade; i++) assert.equal(x[i], before[i], `sample ${i} untouched`)
  // No step larger than the sine's own, and the level only falls through the fade.
  const step = (a: Float32Array, i: number) => Math.abs((a[i] as number) - (a[i - 1] as number))
  const maxStep = LEVEL * w * 1.0001
  for (let i = 1; i < x.length; i++) assert.ok(step(x, i) <= maxStep, `click at ${i}`)
  for (let i = x.length - fade; i < x.length; i++)
    assert.ok(Math.abs(x[i] as number) <= Math.abs(before[i] as number), `louder at ${i}`)
  // Shorter than the fade: the whole buffer fades.
  const short = new Float32Array(10).fill(LEVEL)
  tailFade(short, 1, RATE)
  assert.equal(short[9], 0)
  assert.ok(Math.abs((short[0] as number) - LEVEL * 0.9) < 1e-6, `short[0] = ${short[0]}`)
})

test('filters keep their state across the whole array', () => {
  const x = Float32Array.from({ length: 4800 }, (_, i) => LEVEL * Math.sin(i * 0.3))
  const whole = biquad(x.slice(), { type: 'lowpass', freq: 800, q: Math.SQRT1_2 }, RATE)
  const tail = biquad(x.slice(2400), { type: 'lowpass', freq: 800, q: Math.SQRT1_2 }, RATE)
  assert.notEqual(whole[2400], tail[0], 'a fresh call starts from silence')
  const once = onePole(new Float32Array(100).fill(LEVEL), 1000, RATE)
  assert.ok((once[99] as number) > (once[0] as number), 'onePole rises across the array')
})

test('bad parameters are refused, not clamped', () => {
  const x = new Float32Array(8)
  assert.throws(() => onePole(x, 24000, RATE), /Nyquist/)
  assert.throws(() => onePole(x, 0, RATE), /Nyquist/)
  assert.throws(() => onePole(x, 1000, 0), /sampleRate/)
  assert.throws(() => biquad(x, { type: 'lowpass', freq: 24000, q: 1 }, RATE), /Nyquist/)
  assert.throws(() => biquad(x, { type: 'lowpass', freq: 30000, q: 1 }, RATE), /Nyquist/)
  assert.throws(() => biquad(x, { type: 'lowpass', freq: -5, q: 1 }, RATE), /Nyquist/)
  assert.throws(() => biquad(x, { type: 'highpass', freq: 1000, q: 0 }, RATE), /q must be above 0/)
  assert.throws(() => biquad(x, { type: 'notch', freq: 1000, q: -1 }, RATE), /q must be above 0/)
  assert.throws(
    () => biquad(x, { type: 'peak', freq: 1000, q: 1 } as unknown as Biquad, RATE),
    /needs gainDb/,
  )
  assert.throws(
    () => biquad(x, { type: 'lowpass', freq: 1000, q: 1, gainDb: 3 } as unknown as Biquad, RATE),
    /takes no gainDb/,
  )
  assert.throws(() => tailFade(x, 0, RATE), /seconds/)
  assert.throws(() => tailFade(x, 0.01, -1), /sampleRate/)
})
