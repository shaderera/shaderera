import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Child } from '../node/child.ts'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import type { Project } from '../node/project.ts'
import type { Job } from '../project/jobs.ts'
import { exportFinishing } from './finishing.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const fixture = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `shaderera-${name}-`))
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
  const job = { name: 'bad', output: { width: 64, height: 36, fps: 10, from: 0, to: 1 } } as Job
  const dir = join(project.root, 'out', 'bad')
  await assert.rejects(
    exportFinishing(project, child, job, { dir, quick: true }),
    /not deterministic/,
  )
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(`${dir}.partial`), false)
})
