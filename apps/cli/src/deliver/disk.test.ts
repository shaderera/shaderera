import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { afterEach, test } from 'node:test'
import { findings } from '../cli/findings.ts'
import type { Child } from '../node/child.ts'
import type { Job } from '../project/jobs.ts'
import type { Plan } from './chunks.ts'
import {
  checkDisk,
  finalFileBytes,
  frameEstimate,
  preflightBatch,
  preflightChunk,
  preflightPng,
  sampleTimes,
  setFreeSpace,
  statfsFree,
} from './disk.ts'

afterEach(() => {
  setFreeSpace()
  findings.length = 0
})

const W = 64
const H = 36
/** A host whose every frame is the same flat colour, counting its renders. */
const flat = () => {
  const asked: number[] = []
  const child = {
    render: async (t: number) => {
      asked.push(t)
      return { pixels: new Uint8Array(W * H * 4).fill(128) }
    },
  } as unknown as Child
  return { child, asked }
}

const job = (format: Job['delivery']['format'] = 'png') =>
  ({
    name: 'spot',
    output: { width: W, height: H, fps: 25, from: 0, to: 4 },
    delivery: { format, quality: 'review', color: 'sdr-bt709' },
  }) as unknown as Job

const plan: Plan = {
  shaderera: 'plan/1',
  job: 'spot',
  jobId: 'x',
  input: 'rgba',
  fps: 25,
  width: W,
  height: H,
  from: 0,
  to: 4,
  chunks: [{ index: 0, from: 0, to: 4, frames: 100, file: 'chunk-000.mkv' }],
}

test('statfs reads free space on a folder not made yet, from the one above it', () => {
  assert.ok(statfsFree(`${process.cwd()}/not/made/yet`) > 0)
})

test('below the estimate is refused with the numbers and --force; --force goes ahead', () => {
  setFreeSpace(() => 2e9)
  assert.throws(
    () => checkDisk('chunk 0 of spot', { dir: '/d', need: 5e9, basis: 'ceiling' }),
    /Not enough disk space for chunk 0 of spot: about 5\.0 GB to write \(raw-pixel ceiling\), 2\.0 GB free on \/d\..*--force/,
  )
  assert.equal(findings.at(-1)?.code, 'disk')
  assert.equal(findings.at(-1)?.severity, 'error')
  const forced = checkDisk('chunk 0', { dir: '/d', need: 5e9, basis: 'ceiling', force: true })
  assert.equal(forced.status, 'forced')
})

test('above the estimate goes ahead; under the margin it warns', () => {
  setFreeSpace(() => 100e9)
  assert.equal(checkDisk('x', { dir: '/d', need: 5e9, basis: 'sampled' }).status, 'ok')
  assert.equal(findings.at(-1)?.severity, 'info')
  assert.match(findings.at(-1)?.measured ?? '', /about 5\.0 GB .* 100\.0 GB free/)
  setFreeSpace(() => 5.5e9)
  assert.equal(checkDisk('x', { dir: '/d', need: 5e9, basis: 'sampled' }).status, 'low')
})

test('a png job is estimated from three sampled frames spread over its window', async () => {
  const { child, asked } = flat()
  setFreeSpace(() => 1e12)
  const r = await preflightPng(child, job(), '/d', {})
  assert.equal(r.basis, 'sampled')
  assert.deepEqual(asked, sampleTimes(Array.from({ length: 100 }, (_, i) => i / 25)))
  assert.equal(asked.length, 3)
  // A flat frame compresses far below its raw 9216 bytes.
  assert.ok(r.need - 48000 * 6 * 4 < 100 * W * H * 4)
  setFreeSpace(() => 1000)
  await assert.rejects(preflightPng(child, job(), '/d', {}), /Not enough disk space for job spot/)
})

test('a sequential source counts at the raw ceiling, rendering nothing', async () => {
  const { child, asked } = flat()
  setFreeSpace(() => 1e12)
  const r = await preflightChunk(child, plan, 0, '/d', { sequential: true })
  assert.equal(r?.basis, 'ceiling')
  assert.equal(r?.need, 100 * W * H * 4)
  assert.deepEqual(asked, [])
})

test('a failing sample falls back to the ceiling', async () => {
  const child = { render: async () => Promise.reject(new Error('boom')) } as unknown as Child
  const r = await frameEstimate('png', {
    input: 'rgba',
    width: W,
    height: H,
    times: [0, 1],
    render: (t) => child.render(t, 'final', 'rgba').then((f) => f.pixels),
  })
  assert.deepEqual(r, { bytes: W * H * 4, basis: 'ceiling' })
})

test('a chunk is sampled as FFV1', {
  skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'no ffmpeg',
}, async () => {
  const { child } = flat()
  setFreeSpace(() => 1e12)
  const r = await preflightChunk(child, plan, 0, '/d', {})
  assert.equal(r?.basis, 'sampled')
  assert.ok((r?.need ?? 0) > 0 && (r?.need ?? 0) < 100 * W * H * 4)
})

test('deliver counts a video by its bitrate and a png job at the ceiling', () => {
  setFreeSpace(() => 1e12)
  const mp4 = { ...job('mp4'), delivery: { ...job('mp4').delivery, bitrate: '8M' } } as Job
  assert.equal(
    finalFileBytes(mp4.delivery, { width: W, height: H, fps: 25, seconds: 4 }),
    (1e6 + 40_000) * 4,
  )
  const r = preflightBatch([mp4, job('png')], '/d', {})
  assert.equal(r.need, (1e6 + 40_000) * 4 + 100 * W * H * 4 + 48000 * 6 * 4)
})
