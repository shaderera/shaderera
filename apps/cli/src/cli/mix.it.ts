import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { SampledClip } from '@shaderera/core'
import { sampleClips } from '@shaderera/core/host'
import { floatWav, mixWav, openMix } from './mix.ts'

const skip = spawnSync('ffmpeg', ['-version']).status !== 0 && 'no ffmpeg'

// Tiny sounds in one folder, the project root the clips' srcs are relative to.
const root = mkdtempSync(join(tmpdir(), 'shaderera-mix-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

const lavfi = (name: string, source: string, ...flags: string[]) => {
  const r = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    source,
    ...flags,
    join(root, name),
  ])
  assert.equal(r.status, 0, String(r.stderr))
  return name
}
/** A stereo ramp, sample i = i / 96000: where each sample of the mix came from is its value. */
const ramp = (name: string) => {
  const x = new Float32Array(96000).map((_, i) => i / 96000)
  writeFileSync(join(root, name), floatWav({ sampleRate: 48000, channels: [x, x] }))
  return name
}
/** A file's samples as 32-bit floats, channels interleaved. */
const samples = (file: string) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-'], {
    maxBuffer: 1 << 26,
  })
  return new Float32Array(
    r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length),
  )
}
/** The first channel of a stereo WAV. */
const left = (file: string) => samples(file).filter((_, i) => i % 2 === 0)
const out = (name: string) => join(root, name)
const window = { from: 0, to: 0.5 }

test('a src with no audio stream is silence (#102); nothing heard writes nothing', { skip }, () => {
  const tone = lavfi('tone.wav', 'sine=frequency=440:duration=0.5')
  const picture = lavfi(
    'picture.mp4',
    'color=red:s=16x16:d=0.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
  )
  const both = mixWav(
    root,
    [
      { src: tone, at: 0 },
      { src: picture, at: 0.2 },
    ],
    window,
    {
      out: out('both.wav'),
    },
  )
  mixWav(root, [{ src: tone, at: 0 }], window, { out: out('tone-only.wav') })
  assert.deepEqual(
    both.clips.map((c) => c.src),
    [tone],
  )
  assert.deepEqual(readFileSync(out('both.wav')), readFileSync(out('tone-only.wav')))

  const mix = openMix(root, [{ src: picture, at: 0.2 }], window)
  assert.deepEqual([mix.clips, mix.encode()], [[], null])
  mix.close()
  const none = mixWav(root, [{ src: picture, at: 0 }], window, { out: out('none.wav') })
  assert.deepEqual(none, { clips: [], loudness: null })
  assert.equal(existsSync(out('none.wav')), false)
})

test('a clip that cannot be read fails naming the clip', { skip }, () => {
  writeFileSync(join(root, 'broken.mp4'), 'not a video')
  const pcm = { sampleRate: 48000, channels: [new Float32Array(480)] }
  assert.throws(
    () =>
      openMix(
        root,
        [
          { pcm, at: 0 },
          { src: 'broken.mp4', at: 0 },
        ],
        window,
      ),
    /Audio clip 1 \(broken\.mp4\) cannot be read: .*broken\.mp4/s,
  )
  assert.throws(
    () => openMix(root, [{ src: 'missing.wav', at: 0 }], window),
    /Audio clip 0 \(missing\.wav\) cannot be read/,
  )
  const three = { sampleRate: 48000, channels: [pcm.channels[0], pcm.channels[0], pcm.channels[0]] }
  assert.throws(
    () => openMix(root, [{ pcm: three as typeof pcm, at: 0 }], window),
    /Audio clip 0 \(pcm\): A pcm clip has one or two channels/,
  )
})

test('gain: a constant scales the clip; a function is multiplied in sample by sample', {
  skip,
}, () => {
  const tone = lavfi('gain.wav', 'sine=frequency=440:sample_rate=48000:duration=1')
  const w = { from: 0, to: 1 }
  mixWav(root, [{ src: tone, at: 0 }], w, { out: out('full.wav') })
  mixWav(root, [{ src: tone, at: 0, gain: 0.5 }], w, { out: out('half.wav') })
  const full = left(out('full.wav'))
  const half = left(out('half.wav'))
  for (let i = 0; i < full.length; i += 97)
    assert.ok(Math.abs((half[i] as number) - 0.5 * (full[i] as number)) < 1e-6, `sample ${i}`)

  const clips = sampleClips([{ src: tone, at: 0, gain: (t) => (t < 0.5 ? 0 : 1) }], 1)
  mixWav(root, clips as SampledClip[], w, { out: out('fade.wav') })
  const fade = left(out('fade.wav'))
  const rms = (x: Float32Array, a: number, b: number) => {
    let s = 0
    for (let i = a * 48000; i < b * 48000; i++) s += (x[i] ?? 0) ** 2
    return Math.sqrt(s / ((b - a) * 48000))
  }
  assert.ok(rms(fade, 0.05, 0.45) < 1e-4, `before: ${rms(fade, 0.05, 0.45)}`)
  const level = rms(full, 0.55, 0.95)
  assert.ok(Math.abs(rms(fade, 0.55, 0.95) - level) < level * 0.001)
  assert.throws(
    () => sampleClips([{ src: 'a.wav', at: 0, gain: (t) => (t > 0.2 ? Number.NaN : 1) }], 1),
    /The gain of a\.wav returned NaN at t = 0\.201/,
  )
})

test('a clip is read from the right sample: a negative at, a delay, a window from mid-clip', {
  skip,
}, () => {
  const src = ramp('ramp.wav')
  // [what the mix's sample k is: the ramp's sample offset + k, or silence before `delay` samples]
  const cases: [SampledClip, { from: number; to: number }, number, number][] = [
    [{ src, at: -0.25, from: 0.1 }, { from: 0, to: 0.5 }, 0.35 * 48000, 0],
    [{ src, at: 0.25 }, { from: 0, to: 0.5 }, -0.25 * 48000, 0.25 * 48000],
    [{ src, at: 1, from: 0.5 }, { from: 2, to: 2.5 }, 1.5 * 48000, 0],
  ]
  for (const [clip, w, offset, delay] of cases) {
    mixWav(root, [clip], w, { out: out('placed.wav') })
    const x = left(out('placed.wav'))
    assert.equal(x.length, 24000)
    for (let k = 0; k < x.length; k += 101) {
      const want = k < delay ? 0 : (offset + k) / 96000
      assert.ok(
        Math.abs((x[k] as number) - want) < 1e-6,
        `${JSON.stringify(clip)} k=${k}: ${x[k]} ≠ ${want}`,
      )
    }
  }
})

test('the stems sum to the mix, with the same constant gain', { skip }, () => {
  const clips = [
    { src: lavfi('a.wav', 'sine=frequency=220:duration=0.5'), at: 0, group: 'music', gain: 0.5 },
    { src: lavfi('b.wav', 'sine=frequency=880:duration=0.5'), at: 0.1, group: 'fx' },
    { src: lavfi('c.wav', 'sine=frequency=440:duration=0.5'), at: 0.2 },
  ]
  const mixed = mixWav(root, clips, window, {
    out: out('mix.wav'),
    stems: out('stems'),
    loudness: -20,
  })
  assert.deepEqual(
    mixed.stems?.map((f) => f.slice(out('stems').length + 1)),
    ['music.wav', 'fx.wav', 'ungrouped.wav'],
  )
  const parts = (mixed.stems ?? []).map(samples)
  const whole = samples(out('mix.wav'))
  let worst = 0
  for (let i = 0; i < whole.length; i++)
    worst = Math.max(
      worst,
      Math.abs(parts.reduce((sum, p) => sum + (p[i] ?? 0), 0) - (whole[i] as number)),
    )
  assert.ok(worst < 1e-5, `stems differ from the mix by ${worst}`)
})

test('loudness: one constant gain brings the mix to the target, the shape kept', { skip }, () => {
  const tone = lavfi('loud.wav', 'sine=frequency=1000:duration=0.5')
  const target = mixWav(root, [{ src: tone, at: 0 }], window, {
    out: out('target.wav'),
    loudness: -20,
  })
  const plain = mixWav(root, [{ src: tone, at: 0 }], window, { out: out('plain.wav') })
  assert.ok(target.loudness && plain.loudness && target.gainDb !== undefined)
  assert.ok(Math.abs(target.loudness.integrated + 20) < 0.1, `${target.loudness.integrated} LUFS`)
  assert.ok(Math.abs(target.gainDb - (-20 - plain.loudness.integrated)) < 0.1)
  // The true peak moves by the same dB: nothing compresses or limits it.
  assert.ok(Math.abs(target.loudness.truePeak - plain.loudness.truePeak - target.gainDb) < 0.1)
  const a = left(out('target.wav'))
  const b = left(out('plain.wav'))
  const ratio = 10 ** (target.gainDb / 20)
  for (let i = 0; i < a.length; i += 89)
    assert.ok(Math.abs((a[i] as number) - ratio * (b[i] as number)) < 1e-5, `sample ${i}`)
})

test("an encode without an edit list loses the AAC encoder's priming, 1024 samples", {
  skip,
}, () => {
  const mix = openMix(root, [{ src: ramp('ramp.wav'), at: 0 }], window)
  try {
    const run = (trim: boolean) => {
      const audio = mix.encode(trim)
      assert.ok(audio)
      const file = out(`trim-${trim}.wav`)
      const video = ['-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.5']
      const r = spawnSync('ffmpeg', [
        ...['-v', 'error', '-y', ...video, ...audio.inputs, '-filter_complex', audio.graph],
        ...['-map', '[aout]', '-c:a', 'pcm_f32le', '-t', '0.5', file],
      ])
      assert.equal(r.status, 0, String(r.stderr))
      return left(file)
    }
    const whole = run(false)
    const trimmed = run(true)
    for (let k = 0; k < 20000; k += 113)
      assert.ok(Math.abs((trimmed[k] as number) - (whole[k + 1024] as number)) < 1e-6, `k=${k}`)
  } finally {
    mix.close()
  }
})

test('the temporary files are removed, after a throw too', { skip }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'shaderera-mix-temp-'))
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp })
  try {
    assert.equal(tmpdir(), temp)
    // Sound made in code and a gain over time each need a temporary file; so does measuring.
    const pcm = { sampleRate: 48000, channels: [new Float32Array(4800).fill(0.1)] }
    const [faded] = sampleClips([{ src: ramp('ramp.wav'), at: 0, gain: (t) => t }], 0.5)
    const clips = [{ pcm, at: 0 }, faded as SampledClip]
    assert.throws(
      () =>
        mixWav(root, clips, window, { out: join(root, 'no-such-folder', 'x.wav'), loudness: -20 }),
      /ffmpeg could not mix Audio clip 0 \(pcm\), Audio clip 1 \(ramp\.wav\)/,
    )
    assert.deepEqual(readdirSync(temp), [])
    const mix = openMix(root, clips, window, { loudness: -20 })
    assert.notDeepEqual(readdirSync(temp), [])
    mix.close()
    assert.deepEqual(readdirSync(temp), [])
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    rmSync(temp, { recursive: true, force: true })
  }
})
