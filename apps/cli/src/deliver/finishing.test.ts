import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { timecodeOf } from '@shaderera/core/host'
import { open } from '../cli/args.ts'
import type { Child } from '../node/child.ts'
import type { Project } from '../node/project.ts'
import { createJob, type Job } from '../project/jobs.ts'
import { exportFinishing } from './finishing.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const fixture = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `shaderera-${name}-`))
  cpSync(fileURLToPath(new URL(`../cli/fixtures/${name}/`, import.meta.url)), root, {
    recursive: true,
  })
  return root
}

test('timecode is HH:MM:SS:FF', () => {
  assert.equal(timecodeOf(0, 30), '00:00:00:00')
  assert.equal(timecodeOf(Math.round(3661.5 * 30), 30), '01:01:01:15')
})

test('a finishing handoff never replaces a folder that is not a delivery', async () => {
  // `render --job stills --out .` in the project: refused before anything renders.
  const root = fixture('deliver')
  await assert.rejects(
    exportFinishing({} as Project, {} as Child, {} as Job, { dir: root }),
    /is not a delivery/,
  )
  assert.ok(existsSync(join(root, 'shaderera.json')))
})

test('render --job of a png job writes frames with alpha, audio.wav and delivery.json', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = fixture('deliver')
  const job = await createJob(root, {
    by: 'cli',
    variant: 'square',
    name: 'sq',
    delivery: { format: 'png' },
  })
  const r = spawnSync(process.execPath, [main, 'render', '--root', root, '--job', job.name], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, 'out', 'sq')
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
  // Straight alpha survives: the half-transparent box decodes as alpha ≈ 128 over alpha 0.
  const px = spawnSync('ffmpeg', [
    ...['-v', 'error', '-i', join(dir, 'frames', '000000.png')],
    ...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  ]).stdout
  const at = (x: number, y: number) => [...px.subarray((y * 36 + x) * 4, (y * 36 + x) * 4 + 4)]
  assert.deepEqual(at(0, 0), [0, 0, 0, 0])
  const box = at(6, 18)
  assert.ok(Math.abs((box[3] ?? 0) - 128) <= 1 && Math.abs((box[2] ?? 0) - 255) <= 1, String(box))
  const audio = spawnSync('ffprobe', [
    ...['-v', 'error', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0'],
    join(dir, 'audio.wav'),
  ])
  assert.equal(String(audio.stdout).trim(), '48000,2')
})

test('a non-deterministic source leaves no partial delivery', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = fixture('stateful')
  const { project, child } = await open({ root })
  const job = await createJob(root, { by: 'cli', name: 'bad', delivery: { format: 'png' } })
  try {
    await assert.rejects(
      exportFinishing(project, child, job, { dir: join(root, 'out', 'bad'), quick: true }),
      /not deterministic/,
    )
    assert.equal(existsSync(join(root, 'out', 'bad')), false)
    assert.equal(existsSync(join(root, 'out', 'bad.partial')), false)
  } finally {
    await child.close()
  }
})
