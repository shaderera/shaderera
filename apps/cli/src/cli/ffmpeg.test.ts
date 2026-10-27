import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Probe } from './ffmpeg.ts'
import {
  bitsPerSecond,
  contentLightArg,
  FfmpegError,
  ffmpegArgs,
  ffmpegRelease,
  ffmpegSink,
  hasEditList,
  hdr10Args,
  masteringDisplayArg,
  probe,
  requireFrames,
  requireHdr10,
} from './ffmpeg.ts'
import { matte64 } from './matte64.ts'

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
  // An NVENC review is a constant QP (vbr's cq held it near 15 Mb/s whatever cq was): --crf n is
  // qp n + 1; --maxrate caps a vbr at cq n + 1 instead, as a QP alone takes no ceiling.
  const review = ffmpegArgs({ ...base, encoder: 'nvenc' }).join(' ')
  assert.ok(review.includes('-c:v h264_nvenc -preset p5 -tune hq -rc constqp -qp 19'))
  assert.ok(!review.includes('-cq') && !review.includes('-maxrate'))
  const finer = ffmpegArgs({ ...base, encoder: 'nvenc', crf: 13 }).join(' ')
  assert.ok(finer.includes('-qp 14'))
  const capped = ffmpegArgs({ ...base, encoder: 'nvenc', maxrate: '10M' }).join(' ')
  assert.ok(capped.includes('-rc vbr -b:v 0 -cq 19 -maxrate 10M -bufsize 20000000'))
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

// A fake ffmpeg: node running `script`, which never reads its stdin, so a 8 MB frame waits for drain.
const fake = (script: string, stall?: number) =>
  ffmpegSink([], 'rgba', false, {
    command: [process.execPath, '-e', script],
    ...(stall ? { stall } : {}),
  })
const frame = new Uint8Array(8 << 20)

test('an ffmpeg that exits 0 while a write waits for drain fails it at once, quoting its stderr', async () => {
  // It says when it exits, so "at once" is timed from its exit, not from starting a process on a
  // loaded machine (#422). The watchdog is far off: a write that waited for it fails as a stall.
  const sink = fake(
    "process.stderr.write('[in#0/rawvideo] Error during demuxing: Cannot allocate memory\\n'); setTimeout(() => { process.stderr.write('exits at ' + Date.now() + '\\n'); process.exit(0) }, 100)",
    30,
  )
  let error: FfmpegError | undefined
  await assert.rejects(
    async () => {
      for (;;) await sink.write(frame)
    },
    (e: unknown) => {
      error = e as FfmpegError
      return (
        e instanceof FfmpegError &&
        e.reason === 'exit' &&
        e.code === 0 &&
        /exited with 0 while frames were still coming/.test(e.message) &&
        /Cannot allocate memory/.test(e.message)
      )
    },
  )
  const exitedAt = Number(/exits at (\d+)/.exec(error?.stderr ?? '')?.[1])
  assert.ok(Date.now() - exitedAt < 1000, `failed ${Date.now() - exitedAt} ms after the exit`)
  // A later write fails too, never waits.
  await assert.rejects(sink.write(frame), FfmpegError)
  await sink.abort?.()
})

test('an ffmpeg that stops reading fails the write after the watchdog, naming the stall', async () => {
  const sink = fake('setInterval(() => {}, 1000)', 0.5)
  const start = performance.now()
  await assert.rejects(
    async () => {
      for (;;) await sink.write(frame)
    },
    (e: unknown) =>
      e instanceof FfmpegError &&
      e.reason === 'stall' &&
      /read nothing for 0.5 s .* stalled/.test(e.message),
  )
  assert.ok(performance.now() - start < 1000)
  await sink.abort?.()
})

test('an ffmpeg that never finishes after its input ended fails end after the watchdog (#439)', async () => {
  const sink = fake('process.stdin.resume(); setInterval(() => {}, 1000)', 0.5)
  const start = performance.now()
  await assert.rejects(
    sink.end(),
    (e: unknown) =>
      e instanceof FfmpegError &&
      e.reason === 'stall' &&
      /did not finish within 0.5 s of its last frame: it stalled/.test(e.message),
  )
  assert.ok(performance.now() - start < 2000)
})

test('an ffmpeg whose stderr another process holds after it exits ends all the same (#439)', async () => {
  const held = fileURLToPath(new URL('../fixtures/held-pipe.ts', import.meta.url))
  const sink = ffmpegSink([], 'rgba', false, { command: [process.execPath, held, 'in', '8000'] })
  const start = performance.now()
  await sink.write(new Uint8Array(1 << 20))
  await sink.end()
  assert.ok(performance.now() - start < 5000)
})

test('an exit code is printed signed', async () => {
  const sink = fake('process.exit(-1)')
  await assert.rejects(
    async () => {
      for (;;) await sink.write(frame)
    },
    (e: unknown) =>
      e instanceof FfmpegError &&
      e.code === (process.platform === 'win32' ? -1 : 255) &&
      !/4294967295/.test(e.message),
  )
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

/** The common P3-D65 1000 cd/m² mastering display. */
const P3_1000 = {
  red: [0.68, 0.32],
  green: [0.265, 0.69],
  blue: [0.15, 0.06],
  white: [0.3127, 0.329],
  peak: 1000,
  min: 0.0001,
} as const
const hdr = { ...base, display: P3_1000, levels: { maxCLL: 799.2, maxFALL: 200 } }

test('the mastering display and light levels in ffmpeg 9.0’s units; the levels rounded up', () => {
  assert.equal(
    masteringDisplayArg(P3_1000),
    'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
  )
  assert.equal(contentLightArg({ maxCLL: 799.2, maxFALL: 200 }), '800,200')
})

test('hdr10Args: HEVC Main 10 as hvc1, tagged HDR10, the metadata on the input', () => {
  const line = hdr10Args({ ...hdr, input: 'p010' }).join(' ')
  assert.ok(
    line.includes(
      '-pix_fmt p010le -s 64x36 -r 10 -mastering_display G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1) -content_light 800,200 -i -',
    ),
  )
  assert.ok(
    line.includes(
      '-vf setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv -colorspace bt2020nc -color_primaries bt2020 -color_trc smpte2084 -color_range tv -chroma_sample_location topleft',
    ),
  )
  assert.ok(line.includes('-c:v libx265 -profile:v main10 -preset medium -crf 20'))
  assert.ok(line.includes('-x265-params hdr10-opt=1:repeat-headers=1'))
  assert.ok(line.includes('-tag:v hvc1'))
  const master = hdr10Args({ ...hdr, input: 'yuv420p10le', quality: 'master' }).join(' ')
  assert.ok(master.includes('-pix_fmt yuv420p10le') && master.includes('-preset slow -crf 16'))
  const nvenc = hdr10Args({ ...hdr, input: 'p010', encoder: 'nvenc' }).join(' ')
  assert.ok(nvenc.includes('-c:v hevc_nvenc -profile:v main10'))
  assert.ok(nvenc.includes('-bsf:v hevc_metadata=chroma_sample_loc_type=2 -tag:v hvc1'))
  const vt = hdr10Args({ ...hdr, input: 'p010', encoder: 'videotoolbox' }).join(' ')
  assert.ok(vt.includes('-c:v hevc_videotoolbox -profile:v main10'))
  for (const encoder of ['nvenc', 'videotoolbox'] as const)
    assert.throws(
      () => hdr10Args({ ...hdr, input: 'p010', encoder, quality: 'master' }),
      /master is encoded with x265/,
    )
})

/** What `hevc_videotoolbox` writes, as probed: the tags, chroma site and boxes, and no SEI. */
const vtReview = (
  color = { matrix: 'bt2020nc', primaries: 'bt2020', transfer: 'smpte2084', range: 'tv' },
): Probe => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  bytes: 1,
  duration: 1,
  bitrate: 1,
  video: {
    codec: 'hevc',
    profile: 'Main 10',
    pixFmt: 'yuv420p10le',
    width: 64,
    height: 36,
    fps: 10,
    color,
    hdr10: {
      codecTag: 'hvc1',
      chroma: 'topleft',
      mastering: P3_1000,
      light: { maxCLL: 800, maxFALL: 200 },
      sei: {},
    },
  },
  editList: false,
})

test('requireHdr10: a VideoToolbox review is held to its tags and boxes, not the SEI it cannot write', () => {
  const vt = { encoder: 'videotoolbox', quality: 'review' } as const
  const note = requireHdr10('o.mp4', vtReview(), P3_1000, hdr.levels, 'hevc', vt)
  assert.match(note ?? '', /no HDR10 SEI .*a review, not a master/)
  assert.match(
    requireHdr10('o.mp4', vtReview(), P3_1000, hdr.levels, 'hevc', { encoder: 'videotoolbox' }) ??
      '',
    /a review/,
  )
  // The same file as a master, or from another encoder, still needs the SEI.
  for (const encode of [{ ...vt, quality: 'master' }, { encoder: 'x265' }, {}] as const)
    assert.throws(
      () => requireHdr10('o.mp4', vtReview(), P3_1000, hdr.levels, 'hevc', encode),
      /SEI display none; SEI light none/,
    )
  // Wrong tags fail a review all the same.
  assert.throws(
    () =>
      requireHdr10(
        'o.mp4',
        vtReview({ matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'tv' }),
        P3_1000,
        hdr.levels,
        'hevc',
        vt,
      ),
    /colour .*not bt2020nc\/bt2020\/smpte2084\/tv/,
  )
  const noBoxes = vtReview()
  delete noBoxes.video?.hdr10?.light
  assert.throws(() => requireHdr10('o.mp4', noBoxes, P3_1000, hdr.levels, 'hevc', vt), /clli none/)
})

test('hdr10Args: ProRes from the 10-bit PQ R’G’B’ codes with the BT.2020 matrix; inputs checked', () => {
  const hq = hdr10Args({ ...hdr, out: 'o.mov', input: 'rgb10', codec: 'prores-hq' }).join(' ')
  assert.ok(hq.includes('-pix_fmt x2bgr10le') && hq.includes('-content_light 800,200'))
  assert.ok(hq.includes('scale=out_color_matrix=bt2020:out_range=tv,format=yuv422p10le,setparams'))
  assert.ok(hq.includes('-color_trc smpte2084 -color_range tv -c:v prores_ks -profile:v 3'))
  const full = hdr10Args({ ...hdr, out: 'o.mov', input: 'rgb10', codec: 'prores-4444' })
  assert.ok(full.join(' ').includes('format=yuv444p10le') && !full.includes('-alpha_bits'))
  assert.throws(() => hdr10Args({ ...hdr, input: 'rgb10' }), /p010 or yuv420p10le/)
  assert.throws(() => hdr10Args({ ...hdr, input: 'p010', codec: 'prores-hq' }), /rgb10/)
})

test('ffmpegRelease reads the release in ffmpeg -version, and none from a snapshot build', () => {
  assert.deepEqual(ffmpegRelease('ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright'), {
    major: 9,
    minor: 0,
  })
  assert.deepEqual(ffmpegRelease('ffmpeg version n8.1.1 Copyright (c) 2000-2026'), {
    major: 8,
    minor: 1,
  })
  assert.equal(ffmpegRelease('ffmpeg version N-121234-gabcdef0123 Copyright'), undefined)
})
