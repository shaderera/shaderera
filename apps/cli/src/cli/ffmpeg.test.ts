import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SampledClip } from '@shaderera/core'
import { sampleClips } from '@shaderera/core/host'
import {
  audioMix,
  bitsPerSecond,
  ffmpegArgs,
  ffmpegSink,
  hasEditList,
  matte64,
  PRIMING,
  probe,
  stemsOf,
  wavArgs,
  withGainFiles,
  writeStems,
} from './ffmpeg.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const base = { width: 64, height: 36, fps: 10, from: 0, to: 4, out: 'o.mp4' }

test('ffmpegArgs without audio is video only', () => {
  const args = ffmpegArgs({ ...base, clips: [] })
  assert.deepEqual(args.slice(3, 13), [
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    '64x36',
    '-r',
    '10',
    '-i',
    '-',
  ])
  assert.ok(!args.includes('-filter_complex') && !args.includes('aac'))
  assert.deepEqual(args.slice(-3), ['-t', '4', 'o.mp4'])
})

test('ffmpegArgs delays, trims and mixes clips without scaling', () => {
  const clips = [
    { src: 'a.wav', file: '/p/a.wav', at: 0.4 },
    { src: 'b.wav', file: '/p/b.wav', at: 1, from: 0.5, to: 2, gain: 0.5 },
  ]
  const args = ffmpegArgs({ ...base, clips })
  assert.equal(args[args.indexOf('/p/a.wav') - 1], '-i')
  assert.equal(
    args[args.indexOf('-filter_complex') + 1],
    '[1:a]atrim=start=0,asetpts=PTS-STARTPTS,adelay=400:all=1,volume=1[a0];' +
      '[2:a]atrim=start=0.5:end=2,asetpts=PTS-STARTPTS,adelay=1000:all=1,volume=0.5[a1];' +
      '[a0][a1]amix=inputs=2:normalize=0:duration=longest[mix];[mix]apad,asetnsamples=n=1024:p=0[aout]',
  )
  assert.ok(args.join(' ').includes('-c:a aac -b:a 192k -ar 48000 -ac 2'))
})

test('ffmpegArgs starts mid-clip when the export starts after it', () => {
  const clips = [{ src: 'a.wav', file: '/p/a.wav', at: 1, from: 0.5 }]
  const args = ffmpegArgs({ ...base, from: 2, to: 3, clips })
  assert.match(
    args[args.indexOf('-filter_complex') + 1] as string,
    /atrim=start=1\.5,.*adelay=0:all=1/,
  )
  assert.deepEqual(args.slice(-3), ['-t', '1', 'o.mp4'])
})

test('ffmpegArgs converts with the BT.709 matrix, tags BT.709 and sets the quality preset', () => {
  const review = ffmpegArgs({ ...base, clips: [] }).join(' ')
  assert.ok(review.includes('scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'))
  assert.ok(
    review.includes('-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv'),
  )
  assert.ok(review.includes('-preset medium -crf 18'))
  const master = ffmpegArgs({ ...base, quality: 'master', clips: [] }).join(' ')
  assert.ok(master.includes('-preset slow -crf 12'))
})

test('wavArgs mixes like the mp4 and writes 48 kHz PCM padded to the window', () => {
  const args = wavArgs({
    from: 0,
    to: 2,
    out: 'a.wav',
    clips: [{ src: 'a.wav', file: '/p/a.wav', at: 1 }],
  })
  assert.match(
    args[args.indexOf('-filter_complex') + 1] as string,
    /^\[0:a\]atrim.*\[mix\];\[mix\]apad,asetnsamples=n=1024:p=0\[aout\]$/,
  )
  assert.ok(args.join(' ').includes('-ar 48000 -ac 2 -c:a pcm_s24le -t 2 a.wav'))
})

test('a gain over time is the envelope ffmpeg multiplies in: silent before 0.5 s, full after', {
  skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'no ffmpeg',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-gain-test-'))
  try {
    const tone = join(dir, 'tone.wav')
    spawnSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      tone,
    ])
    const [clip] = sampleClips([{ src: 'tone.wav', at: 0, gain: (t) => (t < 0.5 ? 0 : 1) }], 1)
    const { clips, cleanup } = withGainFiles([{ ...(clip as SampledClip), file: tone }], 0, 1)
    const out = join(dir, 'mix.wav')
    const r = spawnSync('ffmpeg', wavArgs({ from: 0, to: 1, out, clips }), { encoding: 'utf8' })
    cleanup()
    assert.equal(r.status, 0, r.stderr)
    // The same tone at a constant gain of 1, measured the same way, is what full means.
    const full = join(dir, 'full.wav')
    spawnSync(
      'ffmpeg',
      wavArgs({ from: 0, to: 1, out: full, clips: [{ src: 't', file: tone, at: 0, gain: 1 }] }),
    )
    const samples = (file: string) => {
      const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-f', 'f32le', '-'])
      return new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.length / 4)
    }
    const reference = samples(full)
    const x = samples(out)
    const rms = (a: number, b: number, y = x) => {
      let s = 0
      for (let i = a * 48000; i < b * 48000; i++) s += (y[i] ?? 0) ** 2
      return Math.sqrt(s / ((b - a) * 48000))
    }
    assert.ok(rms(0.05, 0.45) < 1e-4, `before: ${rms(0.05, 0.45)}`)
    const after = rms(0.55, 0.95)
    const level = rms(0.55, 0.95, reference)
    assert.ok(Math.abs(after - level) < level * 0.001, `after: ${after}, constant gain: ${level}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a constant gain stays a volume filter and needs no envelope', () => {
  const clips = [{ src: 'a.wav', file: '/p/a.wav', at: 0, gain: 0.25 }]
  assert.equal(withGainFiles(clips, 0, 4).clips[0], clips[0])
  assert.match(audioMix(clips, 0, 0), /volume=0\.25\[a0\]/)
})

test('a gain function must return finite numbers', () => {
  assert.throws(
    () => sampleClips([{ src: 'a.wav', at: 0, gain: (t) => (t > 0.2 ? Number.NaN : 1) }], 1),
    /The gain of a\.wav returned NaN at t = 0\.201/,
  )
})

test('ProRes: HQ 4:2:2 10-bit or 4444 with alpha, PCM audio; H.264-only options refused', () => {
  const clips = [{ src: 'a.wav', file: '/p/a.wav', at: 0 }]
  const hq = ffmpegArgs({ ...base, out: 'o.mov', clips, codec: 'prores-hq', input: 'rgba64' })
  const line = hq.join(' ')
  assert.ok(line.includes('-pix_fmt rgba64le'))
  assert.ok(line.includes('format=yuv422p10le') && line.includes('-c:v prores_ks -profile:v 3'))
  assert.ok(line.includes('-c:a pcm_s24le -ar 48000 -ac 2') && !line.includes('aac'))
  const alpha = ffmpegArgs({ ...base, out: 'o.mov', clips: [], codec: 'prores-4444' }).join(' ')
  assert.ok(alpha.includes('format=yuva444p10le') && alpha.includes('-profile:v 4 -alpha_bits 16'))
  assert.throws(
    () => ffmpegArgs({ ...base, clips: [], codec: 'prores-hq', bitrate: '15M' }),
    /H\.264/,
  )
})

test('rate control: a constant bitrate with HRD filler, or a ceiling on the crf', () => {
  const cbr = ffmpegArgs({ ...base, clips: [], bitrate: '15M' }).join(' ')
  assert.ok(
    cbr.includes('-b:v 15M -minrate 15M -maxrate 15M -bufsize 15M -x264-params nal-hrd=cbr'),
  )
  assert.ok(!cbr.includes('-crf'))
  const cap = ffmpegArgs({ ...base, clips: [], maxrate: '10M' }).join(' ')
  assert.ok(cap.includes('-crf 18 -maxrate 10M -bufsize 20000000'))
  const nvenc = ffmpegArgs({ ...base, clips: [], bitrate: '8M', encoder: 'nvenc' }).join(' ')
  assert.ok(nvenc.includes('-rc cbr -b:v 8M -maxrate 8M') && !nvenc.includes('-rc vbr'))
  assert.equal(bitsPerSecond('800k'), 800_000)
  assert.throws(() => bitsPerSecond('fast'), /15M or 800k/)
})

test('no edit list: the mix loses the AAC priming, and B-frames keep frame 0 at 0', () => {
  const clips = [{ src: 'a.wav', file: '/p/a.wav', at: 0 }]
  const args = ffmpegArgs({ ...base, clips, editList: false })
  assert.match(
    args[args.indexOf('-filter_complex') + 1] as string,
    /\[mix\]aresample=48000,atrim=start_sample=1024,asetpts=PTS-STARTPTS,apad,asetnsamples=n=1024:p=0\[aout\]$/,
  )
  assert.ok(args.join(' ').includes('-movflags +faststart+negative_cts_offsets -use_editlist 0'))
  assert.equal(PRIMING, 1024)
})

test('matte64 mattes 16-bit straight RGBA over black and makes it opaque', () => {
  const px = new Uint16Array([65535, 32768, 0, 32768, 1000, 1000, 1000, 0])
  const out = new Uint16Array(matte64(new Uint8Array(px.buffer)).buffer)
  assert.deepEqual([...out], [32768, 16384, 0, 65535, 0, 0, 0, 65535])
})

test('stems sum to the mix and an mp4 written with an edit list is told from one without', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-stems-'))
  try {
    const tone = (name: string, f: number) => {
      const file = join(dir, name)
      spawnSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${f}:duration=1`,
        file,
      ])
      return file
    }
    const clips = [
      { src: 'a', file: tone('a.wav', 220), at: 0, group: 'music', gain: 0.5 },
      { src: 'b', file: tone('b.wav', 880), at: 0.25, group: 'fx' },
      { src: 'c', file: tone('c.wav', 440), at: 0.5 },
    ]
    assert.deepEqual([...stemsOf(clips).keys()], ['music', 'fx', 'ungrouped'])
    const stems = writeStems({ clips, from: 0, to: 1, dir: join(dir, 'stems'), gainDb: -3 })
    const mix = join(dir, 'mix.wav')
    spawnSync('ffmpeg', wavArgs({ from: 0, to: 1, out: mix, clips, gainDb: -3 }))
    const samples = (file: string) => {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-'], {
        maxBuffer: 1 << 26,
      })
      return new Float32Array(
        r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length),
      )
    }
    const parts = stems.map(samples)
    const whole = samples(mix)
    let worst = 0
    for (let i = 0; i < whole.length; i++)
      worst = Math.max(
        worst,
        Math.abs(parts.reduce((sum, p) => sum + (p[i] ?? 0), 0) - (whole[i] as number)),
      )
    assert.ok(worst < 1e-5, `stems differ from the mix by ${worst}`)
    for (const editList of [true, false]) {
      const out = join(dir, `${editList}.mp4`)
      const args = ffmpegArgs({ ...base, to: 1, out, clips, editList, input: 'rgba' })
      const raw = new Uint8Array(64 * 36 * 4 * 10)
      spawnSync('ffmpeg', args, { input: raw })
      assert.equal(hasEditList(out), editList)
      assert.equal(probe(out).audio?.sampleRate, 48000)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ffmpeg that exits early fails the write, and the process stays up', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-epipe-'))
  try {
    const args = ffmpegArgs({
      ...base,
      out: join(dir, 'o.mp4'),
      clips: [{ at: 0, file: join(dir, 'missing.wav') }],
    })
    const sink = ffmpegSink(args)
    await assert.rejects(async () => {
      for (let i = 0; i < 400; i++) await sink.write(new Uint8Array(64 * 36 * 4))
      await sink.end()
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasEditList reads box headers only: a 64-bit mdat is skipped, the elst after it found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-boxes-'))
  try {
    const box = (type: string, body: Buffer) => {
      const b = Buffer.alloc(8)
      b.writeUInt32BE(8 + body.length)
      b.write(type, 4, 'latin1')
      return Buffer.concat([b, body])
    }
    // An mdat with a 64-bit size (size field 1), as a master over 4 GiB has.
    const mdat = Buffer.alloc(16 + 100)
    mdat.writeUInt32BE(1)
    mdat.write('mdat', 4, 'latin1')
    mdat.writeBigUInt64BE(BigInt(mdat.length), 8)
    const moov = box('moov', box('trak', box('edts', box('elst', Buffer.alloc(8)))))
    const file = join(dir, 'f.mp4')
    writeFileSync(file, Buffer.concat([box('ftyp', Buffer.alloc(8)), mdat, moov]))
    assert.equal(hasEditList(file), true)
    writeFileSync(file, Buffer.concat([box('ftyp', Buffer.alloc(8)), mdat]))
    assert.equal(hasEditList(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
