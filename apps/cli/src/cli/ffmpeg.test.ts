import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  bitsPerSecond,
  ffmpegArgs,
  ffmpegSink,
  hasEditList,
  matte64,
  probe,
  requireFrames,
} from './ffmpeg.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const base = { width: 64, height: 36, fps: 10, from: 0, to: 4, out: 'o.mp4' }

test('ffmpegArgs without audio is video only', () => {
  const args = ffmpegArgs({ ...base })
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

test('ffmpegArgs converts with the BT.709 matrix, tags BT.709 and sets the quality preset', () => {
  const review = ffmpegArgs({ ...base }).join(' ')
  assert.ok(review.includes('scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'))
  assert.ok(
    review.includes('-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv'),
  )
  assert.ok(review.includes('-preset veryfast -crf 16'))
  const master = ffmpegArgs({ ...base, quality: 'master' }).join(' ')
  assert.ok(master.includes('-preset slow -crf 12'))
})

test('ProRes: HQ 4:2:2 10-bit or 4444 with alpha, PCM audio; H.264-only options refused', () => {
  const audio = { inputs: ['-i', '/p/a.wav'], graph: '[1:a]anull[aout]' }
  const hq = ffmpegArgs({ ...base, out: 'o.mov', audio, codec: 'prores-hq', input: 'rgba64' })
  const line = hq.join(' ')
  assert.ok(line.includes('-pix_fmt rgba64le'))
  assert.ok(line.includes('format=yuv422p10le') && line.includes('-c:v prores_ks -profile:v 3'))
  assert.ok(line.includes('-c:a pcm_s24le -ar 48000 -ac 2') && !line.includes('aac'))
  const alpha = ffmpegArgs({ ...base, out: 'o.mov', codec: 'prores-4444' }).join(' ')
  assert.ok(alpha.includes('format=yuva444p10le') && alpha.includes('-profile:v 4 -alpha_bits 16'))
  assert.throws(() => ffmpegArgs({ ...base, codec: 'prores-hq', bitrate: '15M' }), /H\.264/)
})

test('rate control: a constant bitrate with HRD filler, or a ceiling on the crf', () => {
  const cbr = ffmpegArgs({ ...base, bitrate: '15M' }).join(' ')
  assert.ok(
    cbr.includes('-b:v 15M -minrate 15M -maxrate 15M -bufsize 15M -x264-params nal-hrd=cbr'),
  )
  assert.ok(!cbr.includes('-crf'))
  const cap = ffmpegArgs({ ...base, maxrate: '10M' }).join(' ')
  assert.ok(cap.includes('-crf 16 -maxrate 10M -bufsize 20000000'))
  const nvenc = ffmpegArgs({ ...base, bitrate: '8M', encoder: 'nvenc' }).join(' ')
  assert.ok(nvenc.includes('-rc cbr -b:v 8M -maxrate 8M') && !nvenc.includes('-rc vbr'))
  // The other GPU encoders run at a constant quality only: --crf n is their cq n + 1.
  const qsv = ffmpegArgs({ ...base, encoder: 'qsv', crf: 20 }).join(' ')
  assert.ok(qsv.includes('-c:v h264_qsv -preset medium -global_quality 21'))
  const vt = ffmpegArgs({ ...base, encoder: 'videotoolbox' }).join(' ')
  assert.ok(vt.includes('-c:v h264_videotoolbox -q:v 62'))
  assert.throws(() => ffmpegArgs({ ...base, encoder: 'amf', maxrate: '10M' }), /x264 and nvenc/)
  assert.equal(bitsPerSecond('800k'), 800_000)
  assert.throws(() => bitsPerSecond('fast'), /15M or 800k/)
})

test('no edit list: B-frames keep frame 0 at 0', () => {
  const args = ffmpegArgs({ ...base, editList: false })
  assert.ok(args.join(' ').includes('-movflags +faststart+negative_cts_offsets -use_editlist 0'))
})

test('matte64 mattes 16-bit straight RGBA over black and makes it opaque', () => {
  const px = new Uint16Array([65535, 32768, 0, 32768, 1000, 1000, 1000, 0])
  const out = new Uint16Array(matte64(new Uint8Array(px.buffer)).buffer)
  assert.deepEqual([...out], [32768, 16384, 0, 65535, 0, 0, 0, 65535])
})

test('an ffmpeg that exits early fails the write, and the process stays up', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-epipe-'))
  try {
    const args = ffmpegArgs({
      ...base,
      out: join(dir, 'o.mp4'),
      audio: { inputs: ['-i', join(dir, 'missing.wav')], graph: '[1:a]anull[aout]' },
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

test('a file that ffmpeg finished short, exiting 0, is told from the film', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-short-'))
  try {
    // ffmpeg stops reading after 25 of the window's 40 frames, as on a demuxing error, and exits 0.
    const out = join(dir, 'o.mp4')
    const sink = ffmpegSink(ffmpegArgs({ ...base, out }))
    for (let i = 0; i < 25; i++) await sink.write(new Uint8Array(64 * 36 * 4))
    await sink.end()
    const p = probe(out)
    assert.equal(p.video?.frames, 25)
    requireFrames(out, p, 25)
    assert.throws(() => requireFrames(out, p, 40), /ffmpeg wrote 25 of the 40 frames .* exited 0/)
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
