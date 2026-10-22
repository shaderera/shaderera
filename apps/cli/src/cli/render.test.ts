import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { FfmpegError } from './ffmpeg.ts'
import { exportVideo, transientEncoder } from './render.ts'

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
