// audio-pcm-mix, laid out as `add` lays it out (with motion-random, which its noise comes from).
// Checked: a sound lands on the sample its film time names, with or without a start offset;
// constant-power pan (-3 dB each side at the centre, all on one side at ±1, the same power
// anywhere); samples past either edge are dropped; noise repeats for a seed; check() reports peak,
// NaN/Inf and DC without changing a sample; and a mix written by hand, as films did, comes out the
// same on the plugin apart from its linear pan. Every level is at or below -30 dBFS.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layOut } from './lay-out.ts'

const from = layOut('audio-pcm-mix')
const { add, check, mixBuffer, noise, toPcm } = (await from(
  'src/audio/mix.ts',
)) as typeof import('../audio-pcm-mix/src/audio/mix.ts')
const { stream } = (await from(
  'src/motion/random.ts',
)) as typeof import('../motion-random/src/motion/random.ts')

const SR = 48000
/** -30.5 dBFS. */
const A = 0.03
const db = (x: number) => 20 * Math.log10(x)
const nonZero = (ch: Float32Array) => [...ch.keys()].filter((i) => ch[i] !== 0)

test('audio-pcm-mix: a sound lands on the sample its film time names', () => {
  const buf = mixBuffer({ duration: 2, sampleRate: SR, channels: 1 })
  assert.equal(buf.channels[0]?.length, 2 * SR)
  assert.equal(buf.start, 0)
  add(buf, [A], 1, { gain: 1, pan: 0 })
  add(buf, [A], 100.4 / SR, { gain: 1, pan: 0 })
  add(buf, [A], 200.6 / SR, { gain: 1, pan: 0 })
  assert.deepEqual(nonZero(buf.channels[0] as Float32Array), [100, 201, SR])
  assert.equal(buf.channels[0]?.[SR], Math.fround(A), 'mono: the gain alone')

  // A buffer over [10, 11.5) of the film: film time 10 is its sample 0.
  const span = mixBuffer({ duration: 1.5, sampleRate: SR, channels: 2, start: 10 })
  assert.equal(span.channels[0]?.length, 1.5 * SR)
  add(span, [A, A / 2], 10, { gain: 1, pan: -1 })
  add(span, [A], 10.25, { gain: 1, pan: -1 })
  assert.deepEqual(nonZero(span.channels[0] as Float32Array), [0, 1, SR / 4])
  assert.equal(span.channels[0]?.[1], Math.fround(A / 2))
})

test('audio-pcm-mix: constant-power pan, -3 dB each side at the centre', () => {
  const at = (pan: number) => {
    const buf = mixBuffer({ duration: 0.01, sampleRate: SR, channels: 2 })
    add(buf, [A], 0, { gain: 1, pan })
    return [buf.channels[0]?.[0] as number, buf.channels[1]?.[0] as number]
  }
  const [l, r] = at(0)
  assert.equal(l, r)
  assert.ok(Math.abs(db(l / A) - -3.0103) < 1e-4, `centre ${db(l / A)} dB`)
  assert.deepEqual(at(-1), [Math.fround(A), 0])
  assert.deepEqual(at(1), [0, Math.fround(A)])
  for (let p = -1; p <= 1; p += 0.125) {
    const [a, b] = at(p)
    assert.ok(Math.abs(a * a + b * b - A * A) < 1e-9, `power at pan ${p}`)
  }
  const [a, b] = at(-0.5)
  assert.ok(a > b, 'negative is left')
  assert.throws(() => at(1.5), /pan 1.5 is outside \[-1, 1\]/)
  assert.throws(() => at(Number.NaN), RangeError)
})

test('audio-pcm-mix: samples past either edge are dropped', () => {
  const buf = mixBuffer({ duration: 10 / SR, sampleRate: SR, channels: 2 })
  const ramp = Float32Array.from({ length: 6 }, (_, i) => (i + 1) * 0.001)
  add(buf, ramp, -3 / SR, { gain: 1, pan: -1 })
  add(buf, ramp, 7 / SR, { gain: 1, pan: -1 })
  add(buf, ramp, 20 / SR, { gain: 1, pan: -1 })
  add(buf, ramp, -20 / SR, { gain: 1, pan: -1 })
  assert.deepEqual(
    [...(buf.channels[0] as Float32Array)],
    [0.004, 0.005, 0.006, 0, 0, 0, 0, 0.001, 0.002, 0.003].map(Math.fround),
  )
  // From a start offset, a sound before the span is cut the same way.
  const span = mixBuffer({ duration: 4 / SR, sampleRate: SR, channels: 1, start: 5 })
  add(span, ramp, 5 - 2 / SR, { gain: 1, pan: 0 })
  assert.deepEqual(
    [...(span.channels[0] as Float32Array)],
    [0.003, 0.004, 0.005, 0.006].map(Math.fround),
  )
})

test('audio-pcm-mix: noise repeats for a seed, in [-1, 1)', () => {
  const a = Float32Array.from({ length: 50000 }, noise(7))
  const b = Float32Array.from({ length: 50000 }, noise(7))
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, Float32Array.from({ length: 50000 }, noise(8)))
  const s = stream(7)
  assert.equal(noise(7)(), s() * 2 - 1, "motion-random's stream")
  assert.ok(a.every((v) => v >= -1 && v < 1))
  const mean = a.reduce((m, v) => m + v, 0) / a.length
  assert.ok(Math.abs(mean) < 0.01, `mean ${mean}`)
})

test('audio-pcm-mix: check() gives peak, NaN/Inf and DC, and fixes nothing', () => {
  const buf = mixBuffer({ duration: 4 / SR, sampleRate: SR, channels: 2 })
  buf.channels[0]?.set([0.01, -0.03, 0.01, Number.NaN])
  buf.channels[1]?.set([0.02, 0.02, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
  const before = buf.channels.map((c) => [...c])
  const c = check(buf)
  assert.equal(c.peak, Math.fround(0.03))
  assert.equal(c.nonFinite, 3)
  assert.ok(Math.abs((c.dc[0] as number) - Math.fround(-0.01 / 3)) < 1e-9)
  assert.equal(c.dc[1], Math.fround(0.02))
  assert.deepEqual(
    buf.channels.map((ch) => [...ch]),
    before,
  )
  assert.deepEqual(check(mixBuffer({ duration: 0.001, sampleRate: SR, channels: 1 })), {
    peak: 0,
    nonFinite: 0,
    dc: [0],
  })
  const pcm = toPcm(buf)
  assert.deepEqual(Object.keys(pcm).sort(), ['channels', 'sampleRate'])
  assert.equal(pcm.channels[0], buf.channels[0], 'the same arrays, no copy')
})

test('audio-pcm-mix: a mix written by hand comes out the same on the plugin, apart from its pan', () => {
  // The plumbing films wrote inside their synth(): a stereo buffer, a seeded noise buffer, times in
  // beats turned to samples by hand, and put(i, v, pan) with a linear pan.
  const beat = 0.5
  const duration = 3
  const hits: [beats: number, gain: number, pan: number][] = [
    [0, 0.03, 0],
    [1, 0.02, 0],
    [1.5, 0.01, 0.3],
    [2.25, 0.02, 0],
    [4, 0.015, -0.4],
    [5.75, 0.03, 0],
  ]
  const hit = (seedBuf: Float32Array, i0: number, j: number) =>
    (seedBuf[(i0 + j) % seedBuf.length] as number) * Math.exp((-j / SR) * 40)
  const len = SR * 0.4

  const byHand = () => {
    const n = Math.ceil(duration * SR)
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    let seed = 7
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
    const nz = new Float32Array(n).map(() => rnd() * 2 - 1)
    const put = (i: number, v: number, pan: number) => {
      if (i < 0 || i >= n) return
      L[i] = (L[i] as number) + v * (1 - Math.max(0, pan))
      R[i] = (R[i] as number) + v * (1 + Math.min(0, pan))
    }
    for (const [b, g, pan] of hits) {
      const i0 = Math.round(b * beat * SR)
      for (let j = 0; j < len; j++) put(i0 + j, hit(nz, i0, j) * g, pan)
    }
    return [L, R]
  }

  const onPlugin = () => {
    const buf = mixBuffer({ duration, sampleRate: SR, channels: 2 })
    const nz = Float32Array.from({ length: duration * SR }, noise(7))
    for (const [b, g, pan] of hits) {
      const at = b * beat
      const i0 = Math.round(at * SR)
      const sound = Array.from({ length: len }, (_, j) => hit(nz, i0, j))
      // Linear pan put the whole of a centred sound on each side: +3 dB over constant power.
      add(buf, sound, at, { gain: g * Math.SQRT2, pan })
    }
    return buf.channels
  }

  const [hl, hr] = byHand() as [Float32Array, Float32Array]
  const [pl, pr] = onPlugin() as [Float32Array, Float32Array]
  // The samples where a panned hit sounds differ; everywhere else they are the same.
  const panned = (i: number) =>
    hits.some(([b, , pan]) => {
      const i0 = Math.round(b * beat * SR)
      return pan !== 0 && i >= i0 && i < i0 + len
    })
  let same = 0
  let differ = 0
  for (let i = 0; i < hl.length; i++) {
    const d = Math.max(
      Math.abs((hl[i] as number) - (pl[i] as number)),
      Math.abs((hr[i] as number) - (pr[i] as number)),
    )
    if (panned(i)) {
      if (d > 1e-6) differ++
    } else {
      assert.equal(d, 0, `sample ${i} differs by ${d}`)
      same++
    }
  }
  assert.ok(same > SR && differ > SR / 10, `${same} same, ${differ} differ under the pans`)
})
