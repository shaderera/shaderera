import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { canEncode, encoderSaid, encodersFile, FfmpegError } from './ffmpeg.ts'
import { encoderRefused, exportVideo, progressLines, transientEncoder } from './render.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

test('render refuses a source that is not deterministic and leaves no file', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject()
  // Each frame a little brighter than the one before: a revisit gives other pixels.
  let n = 0
  const child = memoryChild({
    size: { width: 64, height: 36 },
    frame: () => new Uint8Array(64 * 36 * 4).fill(n++ % 256),
  })
  const out = join(project.root, 'out', 'refused.mp4')
  // An explicit encoder: no GPU probe, which would write the real ~/.shaderera/encoders.json.
  await assert.rejects(
    exportVideo(project, child, { out, revision: 'test', encoder: 'x264' }),
    /Not exported: the source is not deterministic \(t=[\d.]+ after t=[\d.]+: pixels/,
  )
  assert.equal(existsSync(out), false)
})

test('an encode that runs out of memory once succeeds with --retries 1, and fails without', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject()
  const child = memoryChild({ size: { width: 64, height: 36 } })
  const out = join(project.root, 'out', 'retried.mp4')
  // The chunks of a plan, read again on each try; the first read meets ffmpeg's ENOMEM exit.
  let reads = 0
  const frames = {
    input: 'rgba' as const,
    count: 3,
    read: async function* () {
      if (reads++ === 0) throw new FfmpegError('ffmpeg exited with -12.', 'exit', -12, '')
      for (let i = 0; i < 3; i++) yield new Uint8Array(64 * 36 * 4).fill(i * 40)
    },
  }
  const o = { out, revision: 'test', to: 0.3, encoder: 'x264' as const, audio: false, frames }
  await assert.rejects(exportVideo(project, child, o), FfmpegError)
  assert.equal(existsSync(out), false)
  reads = 0
  const warn = console.warn
  const lines: string[] = []
  console.warn = (line: string) => void lines.push(line)
  try {
    const done = await exportVideo(project, child, { ...o, retries: 1 })
    assert.equal(done.frames, 3)
  } finally {
    console.warn = warn
  }
  assert.equal(reads, 2)
  assert.match(lines.join('\n'), /! The encode failed: ffmpeg exited with -12\. Retry 1\/1/)
})

test('which encoder failures are retried', () => {
  const exit = (code: number | null) => new FfmpegError('x', 'exit', code, '')
  // A stall; a demuxer out of memory (0), ENOMEM on Windows and POSIX, an access violation, a signal.
  assert.equal(transientEncoder(new FfmpegError('x', 'stall', null, '')), true)
  for (const code of [0, -12, 244, 0xc0000005 | 0, null])
    assert.equal(transientEncoder(exit(code)), true, String(code))
  // An unknown option (AVERROR_OPTION_NOT_FOUND), a missing file (ENOENT), a plain 1, not ffmpeg.
  for (const code of [2880417800 | 0, -2, 1])
    assert.equal(transientEncoder(exit(code)), false, String(code))
  assert.equal(transientEncoder(new Error('ffmpeg exited with -12.')), false)
})

/** What this machine's ffmpeg said when NVENC refused: no capable device, a size it does not take. */
const NO_DEVICE = `[h264_nvenc @ 000002361346f640] No capable devices found
[vf#0:0 @ 00000236151dabc0] Error sending frames to consumers: Generic error in an external library
[vost#0:0/h264_nvenc @ 000002361346c7c0] Task finished with error code: -22 (Invalid argument)
Conversion failed!`
const TOO_SMALL = `[h264_nvenc @ 000001d2a6aee900] InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value.
[vost#0:0/h264_nvenc @ 000001d2a6aede80] [enc:h264_nvenc @ 000001d2a6ac7e80] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.`
/** And when the output could not be written, or an option was bad: no encoder in it. */
const NO_OUTPUT = `[out#0/mp4 @ 0000020a35f00180] Error opening output Z:/nope/x.mp4: No such file or directory
Error opening output file Z:/nope/x.mp4.
Error opening output files: No such file or directory`
const BAD_OPTION = `[vost#0:0/h264_nvenc @ 0000020a35f00180] -t value must be non-negative
Error parsing options for output file out.mp4.`

test('what ffmpeg says tells a GPU encoder refusing from any other failure', () => {
  assert.equal(encoderSaid(NO_DEVICE), true)
  assert.equal(encoderSaid(TOO_SMALL), true)
  assert.equal(encoderSaid('[AMF @ 00000191ef7765c0] DLL amfrt64.dll failed to open'), true)
  assert.equal(encoderSaid(NO_OUTPUT), false)
  assert.equal(encoderSaid(BAD_OPTION), false)
})

test('which encoder failures fall back from a GPU encoder', () => {
  const exit = (code: number | null, said = NO_DEVICE) =>
    new FfmpegError('ffmpeg exited with 1.', 'exit', code, said)
  // A non-zero exit with the encoder's own words: it refused.
  for (const code of [1, -22, -12]) assert.equal(encoderRefused(exit(code)), true, String(code))
  // The same exits without them: the output, an option; the encoder is kept.
  for (const said of [NO_OUTPUT, BAD_OPTION, ''])
    assert.equal(encoderRefused(exit(-22, said)), false, said)
  // The encoder's words before the last lines kept: said by the sink, not in `stderr`.
  assert.equal(encoderRefused(new FfmpegError('x', 'exit', -22, 'Conversion failed!', true)), true)
  // Its input ended early (0), a signal (null), a stall, an error that is not ffmpeg's.
  for (const code of [0, null]) assert.equal(encoderRefused(exit(code)), false, String(code))
  assert.equal(encoderRefused(new FfmpegError('x', 'stall', null, '')), false)
  assert.equal(encoderRefused(new Error('ffmpeg exited with 1.')), false)
})

/**
 * Runs `body` with a home of its own whose encoders.json keeps a yes for NVENC at this size (and a
 * no for the others), as a GPU that worked before would have left it; gives the file after.
 */
const withKeptNvenc = async (width: number, height: number, body: () => Promise<void>) => {
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = process.env.USERPROFILE = tempDir('home')
  try {
    // Any answer writes the file with this ffmpeg's key; then the kept answers are set.
    await canEncode('videotoolbox', width, height)
    const { ffmpeg: key } = JSON.parse(readFileSync(encodersFile(), 'utf8'))
    const answers = Object.fromEntries(
      ['nvenc', 'qsv', 'amf', 'videotoolbox'].map((e) => [
        `${e} ${width}x${height}`,
        e === 'nvenc',
      ]),
    )
    const kept = JSON.stringify({ ffmpeg: key, answers })
    writeFileSync(encodersFile(), kept)
    await body()
    return { kept, after: readFileSync(encodersFile(), 'utf8') }
  } finally {
    Object.assign(process.env, home)
  }
}

/** A plan's chunks whose first read meets `error`, and the count of reads. */
const failingOnce = (width: number, height: number, error: Error, times = 1) => {
  const r = { reads: 0 }
  return Object.assign(r, {
    frames: {
      input: 'rgba' as const,
      count: 3,
      read: async function* () {
        if (r.reads++ < times) throw error
        for (let i = 0; i < 3; i++) yield new Uint8Array(width * height * 4).fill(i * 40)
      },
    },
  })
}

const quietly = async <T>(body: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
  const warn = console.warn
  const lines: string[] = []
  console.warn = (line: string) => void lines.push(line)
  try {
    return { value: await body(), lines }
  } finally {
    console.warn = warn
  }
}

test('an ffmpeg that exits 0 while frames still come does not drop the kept GPU encoder', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  // A size of its own: the tests above have asked this process about 64x36.
  const project = memoryProject({ width: 160, height: 90 })
  const child = memoryChild({ size: { width: 160, height: 90 } })
  const out = join(project.root, 'out', 'early.mp4')
  const early = new FfmpegError(
    'ffmpeg exited with 0 while frames were still coming: it stopped reading its input.',
    'exit',
    0,
    '',
  )
  const plan = failingOnce(160, 90, early)
  const { kept, after } = await withKeptNvenc(160, 90, async () => {
    const o = { out, revision: 'test', to: 0.3, audio: false, frames: plan.frames }
    await assert.rejects(exportVideo(project, child, o), (e) => e === early)
  })
  assert.equal(plan.reads, 1)
  assert.equal(after, kept)
})

test('a GPU encoder that refuses to open falls back to the next encoder, dropping its kept yes', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject({ width: 96, height: 54 })
  const child = memoryChild({ size: { width: 96, height: 54 } })
  const out = join(project.root, 'out', 'fallback.mp4')
  // AVERROR(EINVAL), as NVENC exits when it cannot open an encode session, saying so.
  const plan = failingOnce(
    96,
    54,
    new FfmpegError('ffmpeg exited with -22.', 'exit', -22, NO_DEVICE),
  )
  const { kept, after } = await withKeptNvenc(96, 54, async () => {
    const o = { out, revision: 'test', to: 0.3, audio: false, frames: plan.frames }
    const { value, lines } = await quietly(() => exportVideo(project, child, o))
    assert.equal(value.frames, 3)
    assert.equal(value.encoder, 'x264')
    assert.match(lines.join('\n'), /! nvenc failed where it worked before: rendering again/)
  })
  assert.equal(plan.reads, 2)
  assert.notEqual(after, kept)
  assert.equal(JSON.parse(after).answers['nvenc 96x54'], undefined)
})

test('a bad window is refused before ffmpeg runs, and keeps the GPU encoder', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject({ width: 112, height: 64, duration: 10 })
  const child = memoryChild({ size: { width: 112, height: 64 } })
  const out = join(project.root, 'out', 'window.mp4')
  const { kept, after } = await withKeptNvenc(112, 64, async () => {
    const o = { out, revision: 'test', audio: false }
    const { lines } = await quietly(async () => {
      await assert.rejects(
        exportVideo(project, child, { ...o, from: 8, to: 2 }),
        /The window 8–2 s is outside 0–10 s\./,
      )
      await assert.rejects(
        exportVideo(project, child, { ...o, from: 'a' as unknown as number }),
        /Not a time in seconds: from "a"\./,
      )
    })
    assert.deepEqual(lines, [])
  })
  assert.equal(after, kept)
})

/** An exit with an error whose words name no encoder (a new driver's, say). */
const UNSAID = 'Conversion failed!'

test('a GPU failure ffmpeg does not name: x264 once; it renders, so the GPU encoder is dropped', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject({ width: 144, height: 80 })
  const child = memoryChild({ size: { width: 144, height: 80 } })
  const out = join(project.root, 'out', 'unsaid.mp4')
  const plan = failingOnce(144, 80, new FfmpegError('ffmpeg exited with -22.', 'exit', -22, UNSAID))
  const { kept, after } = await withKeptNvenc(144, 80, async () => {
    const o = { out, revision: 'test', to: 0.3, audio: false, frames: plan.frames }
    const { value, lines } = await quietly(() => exportVideo(project, child, o))
    assert.equal(value.encoder, 'x264')
    assert.match(lines.join('\n'), /trying x264 once[\s\S]*x264 did not: dropped it/)
  })
  assert.equal(plan.reads, 2)
  assert.notEqual(after, kept)
  assert.equal(JSON.parse(after).answers['nvenc 144x80'], undefined)
})

test('a failure x264 repeats (an output it cannot write) gives the first error and keeps the GPU encoder', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject({ width: 160, height: 96 })
  const child = memoryChild({ size: { width: 160, height: 96 } })
  const out = join(project.root, 'out', 'unwritable.mp4')
  const failed = new FfmpegError('ffmpeg exited with -2.', 'exit', -2, NO_OUTPUT)
  const plan = failingOnce(160, 96, failed, 2)
  const { kept, after } = await withKeptNvenc(160, 96, async () => {
    const o = { out, revision: 'test', to: 0.3, audio: false, frames: plan.frames }
    await quietly(() => assert.rejects(exportVideo(project, child, o), (e) => e === failed))
  })
  assert.equal(plan.reads, 2)
  assert.equal(after, kept)
})

test('without a GPU encoder a failed encode is not tried again', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject({ width: 176, height: 96 })
  const child = memoryChild({ size: { width: 176, height: 96 } })
  const out = join(project.root, 'out', 'x264.mp4')
  const failed = new FfmpegError('ffmpeg exited with -22.', 'exit', -22, UNSAID)
  const plan = failingOnce(176, 96, failed)
  const o = { out, revision: 'test', to: 0.3, audio: false, frames: plan.frames }
  const { lines } = await quietly(() =>
    assert.rejects(exportVideo(project, child, { ...o, encoder: 'x264' }), (e) => e === failed),
  )
  assert.deepEqual(lines, [])
  assert.equal(plan.reads, 1)
})

test('a stall goes to --retries, not to the GPU encoder fallback', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject({ width: 128, height: 72 })
  const child = memoryChild({ size: { width: 128, height: 72 } })
  const out = join(project.root, 'out', 'stalled.mp4')
  const stall = new FfmpegError(
    'ffmpeg read nothing for 1 s while a frame waited.',
    'stall',
    null,
    '',
  )
  const plan = failingOnce(128, 72, stall)
  const o = { out, revision: 'test', to: 0.3, audio: false, frames: plan.frames }
  // With the kept NVENC yes picked, a stall is not taken for NVENC refusing.
  const { kept, after } = await withKeptNvenc(128, 72, async () => {
    await assert.rejects(exportVideo(project, child, o), (e) => e === stall)
  })
  assert.equal(plan.reads, 1)
  assert.equal(after, kept)
  // Under --retries 1 it is done again (x264: a GPU's second try is not this test's).
  plan.reads = 0
  const { value, lines } = await quietly(() =>
    exportVideo(project, child, { ...o, retries: 1, encoder: 'x264' }),
  )
  assert.equal(value.frames, 3)
  assert.equal(plan.reads, 2)
  assert.match(lines.join('\n'), /! The encode failed: ffmpeg read nothing .* Retry 1\/1/)
})

test('progress: every frame in place for a terminal, a line every 10 s with the time left for a pipe', () => {
  let clock = 0
  const said: string[] = []
  const write = (line: string) => said.push(line)
  const tty = progressLines({ every: 0, write, now: () => clock })
  clock = 3000
  tty(0, 100)
  clock = 4000
  tty(10, 100)
  // The pace from the first frame on: the 3 s before it were the open.
  assert.deepEqual(said, ['\rframe 1/100', '\rframe 11/100  10.0 fps  0:09 left'])
  said.length = 0
  clock = 0
  const pipe = progressLines({ every: 10_000, write, now: () => clock })
  // 2 frames a second, for an hour and a half of frames.
  for (let i = 0; i < 50; i++) {
    clock = (i + 1) * 500
    pipe(i, 10_800)
  }
  assert.deepEqual(said, [
    'frame 20/10800  2.0 fps  1:29:50 left\n',
    'frame 40/10800  2.0 fps  1:29:40 left\n',
  ])
})
