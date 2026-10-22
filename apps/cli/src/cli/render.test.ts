import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { canEncode, encodersFile, FfmpegError } from './ffmpeg.ts'
import { encoderRefused, exportVideo, transientEncoder } from './render.ts'

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
  await assert.rejects(
    exportVideo(project, child, { out, revision: 'test' }),
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

test('which encoder failures fall back from a GPU encoder', () => {
  const exit = (code: number | null) => new FfmpegError('ffmpeg exited with 1.', 'exit', code, '')
  // A non-zero exit: the encoder may have refused.
  for (const code of [1, -22, -12]) assert.equal(encoderRefused(exit(code)), true, String(code))
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
const failingOnce = (width: number, height: number, error: Error) => {
  const r = { reads: 0 }
  return Object.assign(r, {
    frames: {
      input: 'rgba' as const,
      count: 3,
      read: async function* () {
        if (r.reads++ === 0) throw error
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
  // AVERROR(EINVAL), as NVENC exits when it cannot open an encode session.
  const plan = failingOnce(96, 54, new FfmpegError('ffmpeg exited with -22.', 'exit', -22, ''))
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
