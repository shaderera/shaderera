import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NotDeterministic } from '@shaderera/core'
import { tempDir } from '../fixtures/temp.ts'
import type { Child } from '../node/child.ts'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import type { Project } from '../node/project.ts'
import type { Job } from '../project/jobs.ts'
import { exportFinishing } from './finishing.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const fixture = (name: string) => {
  const root = tempDir(name)
  cpSync(fileURLToPath(new URL(`../cli/fixtures/${name}/`, import.meta.url)), root, {
    recursive: true,
  })
  return root
}

test('a finishing handoff never replaces a folder that is not a delivery', async () => {
  // `render --job stills --out .` in the project: refused before anything renders.
  const root = fixture('deliver')
  await assert.rejects(
    exportFinishing({} as Project, {} as Child, {} as Job, { dir: root }),
    /is not a delivery/,
  )
  assert.ok(existsSync(join(root, 'shaderera.json')))
})

/** fixtures/deliver's square variant in memory: a half-transparent box, a title, a tone at 0.2 s. */
const square = () => {
  const project = memoryProject({ width: 36, height: 36, duration: 0.5 })
  mkdirSync(join(project.root, 'audio'))
  cpSync(
    fileURLToPath(new URL('../cli/fixtures/deliver/audio/tone.wav', import.meta.url)),
    join(project.root, 'audio', 'tone.wav'),
  )
  const child = memoryChild({
    size: { width: 36, height: 36 },
    frame: (t) => {
      const pixels = new Uint8Array(36 * 36 * 4)
      for (let y = 14; y < 22; y++)
        for (let x = Math.round(4 + t * 10); x < Math.round(12 + t * 10); x++)
          pixels.set([0, 128, 255, 128], (y * 36 + x) * 4)
      return pixels
    },
    inspect: () => ({ locale: 'en', text: { id: 'title', text: 'Hello' } }),
    clips: [{ src: 'audio/tone.wav', at: 0.2 }],
  })
  const job = {
    name: 'sq',
    id: 'sq',
    revision: '0123456789abcdef',
    variant: 'square',
    params: { locale: 'en' },
    seed: 0,
    output: { width: 36, height: 36, fps: 10, from: 0, to: 0.5 },
  } as unknown as Job
  return { project, child, job }
}

test('a png job writes frames with alpha, audio.wav and delivery.json', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const { project, child, job } = square()
  const dir = join(project.root, 'out', 'sq')
  await exportFinishing(project, child, job, { dir })
  const d = JSON.parse(readFileSync(join(dir, 'delivery.json'), 'utf8'))
  assert.equal(d.frameCount, 5)
  assert.equal(d.frames.length, 5)
  assert.ok(existsSync(join(dir, 'frames', '000004.png')))
  assert.equal(d.revision, job.revision)
  assert.deepEqual(d.params, { locale: 'en' })
  assert.equal(d.startTimecode, '00:00:00:00')
  assert.match(d.color, /straight alpha; display-referred; not scene-linear/)
  const { loudness, ...wav } = d.audio
  assert.deepEqual(wav, {
    file: 'audio.wav',
    format: 'WAV PCM signed 24-bit',
    sampleRate: 48000,
    channels: 2,
  })
  // Measured (EBU R128), never judged: a target is the placement's, declared where it applies.
  for (const k of ['integrated', 'range', 'truePeak']) assert.equal(typeof loudness[k], 'number', k)
  assert.ok(loudness.truePeak <= 0)
  assert.match(d.versions.ffmpeg, /^ffmpeg version/)
  assert.equal(d.versions.host.host, 'node')
  assert.ok(d.review.checks.length > 0)
  // Straight alpha survives: the half-transparent box decodes as alpha 128 over alpha 0.
  const px = spawnSync('ffmpeg', [
    ...['-v', 'error', '-i', join(dir, 'frames', '000000.png')],
    ...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  ]).stdout
  const at = (x: number, y: number) => [...px.subarray((y * 36 + x) * 4, (y * 36 + x) * 4 + 4)]
  assert.deepEqual(at(0, 0), [0, 0, 0, 0])
  assert.deepEqual(at(6, 18), [0, 128, 255, 128])
  const audio = spawnSync('ffprobe', [
    ...['-v', 'error', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0'],
    join(dir, 'audio.wav'),
  ])
  assert.equal(String(audio.stdout).trim(), '48000,2')
})

test('a non-deterministic source leaves no partial delivery', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject()
  // Each frame a little brighter than the one before: a revisit gives other pixels.
  let n = 0
  const child = memoryChild({
    size: { width: 64, height: 36 },
    frame: () => new Uint8Array(64 * 36 * 4).fill(n++),
  })
  const job = {
    name: 'bad',
    id: 'bad',
    output: { width: 64, height: 36, fps: 10, from: 0, to: 1 },
  } as Job
  const dir = join(project.root, 'out', 'bad')
  await assert.rejects(exportFinishing(project, child, job, { dir, quick: true }), NotDeterministic)
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(`${dir}.partial`), false)
})

test('a png job keeps its frames on any other error, whatever its message says', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  // Only the determinism re-check's NotDeterministic deletes the frames, never the words of a message.
  const project = memoryProject({ width: 16, height: 16 })
  const child = memoryChild({
    size: { width: 16, height: 16 },
    frame: (t) => {
      if (t === 0.4) throw new Error('the GPU says this is not deterministic')
      return new Uint8Array(16 * 16 * 4).fill(Math.round(t * 10))
    },
  })
  const job = {
    name: 'worded',
    id: 'worded',
    output: { width: 16, height: 16, fps: 10, from: 0, to: 1 },
  } as Job
  const dir = join(project.root, 'out', 'worded')
  await assert.rejects(
    exportFinishing(project, child, job, { dir, quick: true }),
    (error: unknown) => !(error instanceof NotDeterministic) && /4 frames kept/.test(String(error)),
  )
  assert.equal(readdirSync(join(`${dir}.partial`, 'frames')).length, 4)
})

/** A job of 20 frames (2 s at 10 fps) whose render fails once, at `failAt` s, while `failing`. */
const resumable = (o: {
  failAt?: number
  preroll?: { seconds: number; fill: 'black' | 'source' }
}) => {
  const project = memoryProject({
    width: 16,
    height: 16,
    duration: 3,
    ...(o.preroll ? { preroll: o.preroll } : {}),
  })
  const state = { failing: o.failAt !== undefined }
  const child = memoryChild({
    size: { width: 16, height: 16 },
    frame: (t) => {
      const i = Math.round(t * 10)
      if (state.failing && t === o.failAt) throw new Error(`host lost at frame ${i}`)
      const pixels = new Uint8Array(16 * 16 * 4)
      for (let p = 0; p < pixels.length; p += 4) pixels.set([i * 7, p % 251, 255 - i, 200], p)
      return pixels
    },
  })
  const job = {
    name: 'long',
    id: 'job-long',
    revision: '0123456789abcdef',
    params: {},
    seed: 0,
    output: { width: 16, height: 16, fps: 10, from: 0.5, to: 2.5 },
  } as unknown as Job
  return { project, child, job, state }
}

const framesOf = (dir: string) =>
  readdirSync(join(dir, 'frames'))
    .sort()
    .map((f) => [f, readFileSync(join(dir, 'frames', f)).toString('base64')])

for (const [name, setup] of [
  [
    'a png job that fails keeps its whole frames and continues from the first missing one',
    {
      failAt: 2.3,
    },
  ],
  [
    'a png job that fails in its preroll continues there',
    {
      failAt: 0.3,
      preroll: { seconds: 0.3, fill: 'source' as const },
    },
  ],
] as const)
  test(name, { skip: !ffmpeg && 'no ffmpeg' }, async () => {
    const whole = resumable({ preroll: 'preroll' in setup ? setup.preroll : undefined })
    const wholeDir = join(whole.project.root, 'out', 'long')
    await exportFinishing(whole.project, whole.child, whole.job, { dir: wholeDir, quick: true })

    const { project, child, job, state } = resumable(setup)
    const dir = join(project.root, 'out', 'long')
    const partial = `${dir}.partial`
    // The frame before the failure: preroll frames come first, the programme from 0.5 s.
    const firstFrame = 'preroll' in setup ? 2 : 5
    const n = Math.round(setup.failAt * 10) - firstFrame
    await assert.rejects(
      exportFinishing(project, child, job, { dir, quick: true }),
      new RegExp(`host lost at frame .*[(]${n} frames kept in .*long[.]partial`),
    )
    assert.equal(existsSync(dir), false)
    assert.deepEqual(
      readdirSync(join(partial, 'frames')),
      Array.from({ length: n }, (_, i) => `${String(i).padStart(6, '0')}.png`),
    )
    // A frame cut off by a crash is a temporary file: never taken for a frame.
    writeFileSync(join(partial, 'frames', `${String(n).padStart(6, '0')}.png.tmp`), 'cut')

    const stamps = () =>
      Array.from(
        { length: n },
        (_, i) =>
          statSync(
            join(existsSync(dir) ? dir : partial, 'frames', `${String(i).padStart(6, '0')}.png`),
          ).mtimeMs,
      )
    const before = stamps()
    state.failing = false
    const done = await exportFinishing(project, child, job, { dir, quick: true })
    assert.equal(done.kept, n)
    assert.equal(done.rendered, done.record.frameCount - n)
    assert.equal(existsSync(partial), false)
    assert.equal(existsSync(join(dir, 'partial.json')), false)
    // The kept frames were not written again.
    assert.deepEqual(stamps(), before)
    // Byte-identical to a job that never stopped, and so is delivery.json's list of frames.
    assert.deepEqual(framesOf(dir), framesOf(wholeDir))
    const record = JSON.parse(readFileSync(join(dir, 'delivery.json'), 'utf8'))
    const wholeRecord = JSON.parse(readFileSync(join(wholeDir, 'delivery.json'), 'utf8'))
    assert.deepEqual(record.frames, wholeRecord.frames)
  })

test('a png job renders again a frame that was cut short', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const { project, child, job, state } = resumable({ failAt: 1.2 })
  const dir = join(project.root, 'out', 'long')
  await assert.rejects(exportFinishing(project, child, job, { dir, quick: true }), /7 frames kept/)
  const last = join(`${dir}.partial`, 'frames', '000006.png')
  writeFileSync(last, readFileSync(last).subarray(0, 40))
  state.failing = false
  const done = await exportFinishing(project, child, job, { dir, quick: true })
  assert.equal(done.kept, 6)
  assert.equal(done.rendered, 14)
})

test('a png job refuses the unfinished frames of another job', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const { project, child, job } = resumable({ failAt: 1.2 })
  const dir = join(project.root, 'out', 'long')
  await assert.rejects(exportFinishing(project, child, job, { dir, quick: true }), /host lost/)
  const other = { ...job, id: 'job-other', name: 'other' } as Job
  await assert.rejects(
    exportFinishing(project, child, other, { dir, quick: true }),
    /long\.partial holds frames of job long \(job-long, 8-bit\), not of other .*delete it or choose another --out/,
  )
  // Nothing of the other job's was written into it.
  assert.equal(
    JSON.parse(readFileSync(join(`${dir}.partial`, 'partial.json'), 'utf8')).jobId,
    'job-long',
  )
})
