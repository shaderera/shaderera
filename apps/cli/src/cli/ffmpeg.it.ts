import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import {
  canEncode,
  encodersFile,
  ffmpegArgs,
  hardwareEncoder,
  hasEditList,
  hasHevcNvenc,
  hdr10Args,
  hdr10Problem,
  measureLoudness,
  probe,
} from './ffmpeg.ts'
import { openMix } from './mix.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const base = { width: 64, height: 36, fps: 10, from: 0, to: 4, out: 'o.mp4' }

test('an mp4 written with an edit list is told from one without; its sound is 48 kHz AAC', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-editlist-'))
  // A 44.1 kHz tone: the mp4 resamples it.
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', join(dir, 'a.wav')])
  const mix = openMix(dir, [{ src: 'a.wav', at: 0 }], { from: 0, to: 1 })
  try {
    for (const editList of [true, false]) {
      const out = join(dir, `${editList}.mp4`)
      const audio = mix.encode(!editList)
      const args = ffmpegArgs({ ...base, to: 1, out, audio, editList, input: 'rgba' })
      assert.ok(args.join(' ').includes('-c:a aac -b:a 192k -ar 48000 -ac 2'))
      spawnSync('ffmpeg', args, { input: new Uint8Array(64 * 36 * 4 * 10) })
      assert.equal(hasEditList(out), editList)
      assert.equal(probe(out).audio?.sampleRate, 48000)
    }
  } finally {
    mix.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the loudness of a film over ten minutes is measured', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-long-'))
  try {
    // 13 minutes of a tone, kept small: 8 kHz, 8 bits, mono.
    const file = join(dir, 'long.wav')
    const args = ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=780:sample_rate=8000']
    spawnSync('ffmpeg', [...args, '-c:a', 'pcm_u8', file])
    const loudness = measureLoudness(file)
    assert.ok(loudness && loudness.integrated > -70, JSON.stringify(loudness))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("A GPU encoder's answer is kept in ~/.shaderera for this ffmpeg, believed after, and asked again fresh", {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = process.env.USERPROFILE = tempDir('home')
  try {
    // Every GPU encoder is asked, and the first that works is the review's.
    const found = await hardwareEncoder(1920, 1080)
    const kept = JSON.parse(readFileSync(encodersFile(), 'utf8'))
    assert.match(kept.ffmpeg, /ffmpeg version/)
    assert.deepEqual(Object.keys(kept.answers).sort(), [
      'amf 1920x1080',
      'nvenc 1920x1080',
      'qsv 1920x1080',
      'videotoolbox 1920x1080',
    ])
    assert.equal(
      found,
      ['nvenc', 'qsv', 'amf', 'videotoolbox'].find((e) => kept.answers[`${e} 1920x1080`]),
    )
    // NVENC refuses a 32×16 frame: a kept true is believed without a test encode...
    const yes = { 'nvenc 32x16': true }
    writeFileSync(encodersFile(), JSON.stringify({ ...kept, answers: yes }))
    assert.equal(await canEncode('nvenc', 32, 16), true)
    // ...and a fresh ask (doctor) encodes again, keeping the answer it had.
    assert.equal(await canEncode('nvenc', 32, 16, { fresh: true }), false)
    const after = JSON.parse(readFileSync(encodersFile(), 'utf8')).answers
    assert.deepEqual(after, { 'nvenc 32x16': false })
    // Another ffmpeg's answers are not this one's.
    const other = { ffmpeg: 'another', answers: { 'nvenc 30x16': true } }
    writeFileSync(encodersFile(), JSON.stringify(other))
    assert.equal(await canEncode('nvenc', 30, 16), false)
    // The nvenc.json of #219's builds (never released) is ignored, left as it is.
    const old = join(dirname(encodersFile()), 'nvenc.json')
    const key = JSON.parse(readFileSync(encodersFile(), 'utf8')).ffmpeg
    writeFileSync(old, JSON.stringify({ ffmpeg: key, sizes: { '28x16': true } }))
    assert.equal(await canEncode('nvenc', 28, 16), false)
    assert.ok(existsSync(old))
  } finally {
    Object.assign(process.env, home)
  }
})

test("HDR10's HEVC NVENC is asked apart: its answer is never kept in encoders.json", {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = process.env.USERPROFILE = tempDir('home')
  try {
    hasHevcNvenc(1920, 1080)
    assert.equal(existsSync(encodersFile()), false)
  } finally {
    Object.assign(process.env, home)
  }
})

/** The common P3-D65 1000 cd/m² mastering display, and levels as a meter measures them. */
const P3_1000 = {
  red: [0.68, 0.32],
  green: [0.265, 0.69],
  blue: [0.15, 0.06],
  white: [0.3127, 0.329],
  peak: 1000,
  min: 0.0001,
} as const
const LEVELS = { maxCLL: 799.2, maxFALL: 199.6 }
/** What the file must say: the display exactly (it is in the SEI's units), the levels rounded up. */
const METADATA = { mastering: P3_1000, light: { maxCLL: 800, maxFALL: 200 } }

/** Ten synthetic frames from ffmpeg's lavfi as `pixFmt`'s raw bytes; through an FFV1 chunk when asked. */
const frames = (dir: string, pixFmt: string, chunk = false) => {
  const src = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=256x144:r=10:d=1']
  const raw = ['-f', 'rawvideo', '-pix_fmt', pixFmt, '-']
  if (!chunk) return spawnSync('ffmpeg', [...src, ...raw], { maxBuffer: 2 ** 26 }).stdout
  const mkv = join(dir, 'chunk.mkv')
  spawnSync('ffmpeg', [...src, '-pix_fmt', 'yuv420p10le', '-c:v', 'ffv1', mkv])
  return spawnSync('ffmpeg', ['-v', 'error', '-i', mkv, ...raw], { maxBuffer: 2 ** 26 }).stdout
}

const hdrBase = { width: 256, height: 144, fps: 10, from: 0, to: 1 }
const encoders = ffmpeg
  ? spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout
  : ''
const hdr10Skip = ffmpeg ? (hdr10Problem() ?? false) : 'no ffmpeg'

// A detailed 960×540 second (a fractal zoom under moving grain), its yuv420p frames the reference.
const RAW_540P = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '960x540', '-r', '30']
const h264Nvenc =
  ffmpeg &&
  spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=s=960x540:d=0.1',
    '-c:v',
    'h264_nvenc',
    '-f',
    'null',
    '-',
  ]).status === 0

test("an NVENC review keeps a detailed film above VMAF 95 (x264's review: about 99), and a lower crf gives a larger, better file", {
  skip: !h264Nvenc && 'no h264_nvenc here',
}, () => {
  const dir = tempDir('nvenc-review')
  const ref = join(dir, 'ref.yuv')
  const source = 'mandelbrot=s=960x540:r=30:end_scale=0.05,noise=alls=24:allf=t,format=yuv420p'
  const made = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    source,
    '-t',
    '1',
    '-f',
    'rawvideo',
    ref,
  ])
  assert.equal(made.status, 0, String(made.stderr))
  const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout
  const vmaf = /\slibvmaf\s/.test(filters)
  const score = (crf?: number) => {
    const out = join(dir, `crf-${crf ?? 'review'}.mp4`)
    const args = ffmpegArgs({
      ...base,
      width: 960,
      height: 540,
      fps: 30,
      to: 1,
      out,
      input: 'yuv420p',
      encoder: 'nvenc',
      crf,
    })
    const r = spawnSync('ffmpeg', args, { input: readFileSync(ref) })
    assert.equal(r.status, 0, String(r.stderr))
    // One timebase and the review's BT.709 tags for both, or VMAF reads low (79 for 98.7 here).
    const tags = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
    const pair = `[0:v]settb=1/30,setpts=N[a];[1:v]${tags},settb=1/30,setpts=N[b];[a][b]`
    const metric = spawnSync('ffmpeg', [
      '-i',
      out,
      ...RAW_540P,
      '-i',
      ref,
      '-lavfi',
      pair + (vmaf ? 'libvmaf' : 'psnr'),
      '-f',
      'null',
      '-',
    ])
    const line = String(metric.stderr).match(vmaf ? /VMAF score: ([\d.]+)/ : /average:([\d.]+)/)
    return { bytes: statSync(out).size, score: Number(line?.[1]) }
  }
  // This 540p second, measured 2026-10-27 (RTX 5070 Ti): VMAF 98.7 / PSNR 38.6 dB at qp 19, where
  // vbr at cq 19 scored 76.5 / 27.0.
  const review = score()
  assert.ok(review.score >= (vmaf ? 95 : 35), JSON.stringify(review))
  const finer = score(12)
  assert.ok(
    finer.bytes > review.bytes * 1.2 && finer.score > review.score,
    JSON.stringify({ review, finer }),
  )
})

const HEVC = [
  { name: 'x265 review from P010', encoder: 'x265', input: 'p010', chunk: false, skip: false },
  {
    name: 'x265 master from an FFV1 chunk',
    encoder: 'x265',
    input: 'yuv420p10le',
    chunk: true,
    skip: false,
  },
  {
    name: 'hevc_nvenc review from P010',
    encoder: 'nvenc',
    input: 'p010',
    chunk: false,
    skip: !hdr10Skip && !hasHevcNvenc(256, 144) && 'no hevc_nvenc here',
  },
  {
    name: 'hevc_videotoolbox review from P010',
    encoder: 'videotoolbox',
    input: 'p010',
    chunk: false,
    skip: !/\shevc_videotoolbox\s/.test(encoders) && 'no hevc_videotoolbox here (macOS only)',
  },
] as const

for (const c of HEVC)
  test(`HDR10 ${c.name}: Main 10 hvc1, tagged, the display and levels in the boxes and the first frame's SEI`, {
    skip: hdr10Skip || c.skip,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'shaderera-hdr10-'))
    try {
      const out = join(dir, 'o.mp4')
      const args = hdr10Args({
        ...hdrBase,
        out,
        input: c.input,
        encoder: c.encoder,
        quality: c.chunk ? 'master' : 'review',
        display: P3_1000,
        levels: LEVELS,
      })
      const pixFmt = c.input === 'p010' ? 'p010le' : c.input
      const r = spawnSync('ffmpeg', args, { input: frames(dir, pixFmt, c.chunk) })
      assert.equal(r.status, 0, String(r.stderr))
      const v = probe(out).video
      assert.equal(v?.codec, 'hevc')
      assert.equal(v?.profile, 'Main 10')
      assert.equal(v?.pixFmt, 'yuv420p10le')
      assert.equal(v?.frames, 10)
      assert.deepEqual(v?.color, {
        matrix: 'bt2020nc',
        primaries: 'bt2020',
        transfer: 'smpte2084',
        range: 'tv',
      })
      const { sei, ...boxes } = v?.hdr10 ?? {}
      assert.deepEqual(boxes, { codecTag: 'hvc1', chroma: 'topleft', ...METADATA })
      // VideoToolbox writes no SEI: the boxes only, which is why it makes reviews only.
      assert.deepEqual(sei, c.encoder === 'videotoolbox' ? {} : METADATA)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

for (const codec of ['prores-hq', 'prores-4444'] as const)
  test(`HDR10 ${codec} from the hosts' 10-bit PQ R'G'B' codes: tagged, the display and levels in the mov's boxes`, {
    skip: hdr10Skip,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'shaderera-hdr10-'))
    try {
      const out = join(dir, 'o.mov')
      const args = hdr10Args({
        ...hdrBase,
        out,
        input: 'rgb10',
        codec,
        display: P3_1000,
        levels: LEVELS,
      })
      const r = spawnSync('ffmpeg', args, { input: frames(dir, 'x2bgr10le') })
      assert.equal(r.status, 0, String(r.stderr))
      const v = probe(out).video
      assert.equal(v?.codec, 'prores')
      assert.equal(v?.frames, 10)
      // 4444 without an alpha plane: the frame came matted.
      assert.equal(v?.pixFmt, codec === 'prores-hq' ? 'yuv422p10le' : 'yuv444p12le')
      assert.deepEqual(v?.color, {
        matrix: 'bt2020nc',
        primaries: 'bt2020',
        transfer: 'smpte2084',
        range: 'tv',
      })
      // No chroma site and no SEI: ProRes has neither.
      assert.deepEqual(v?.hdr10, { codecTag: codec === 'prores-hq' ? 'apch' : 'ap4h', ...METADATA })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
