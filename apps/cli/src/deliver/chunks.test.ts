import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import type { Job } from '../project/jobs.ts'
import {
  checkChunks,
  chunkStates,
  decodeFrames,
  makePlan,
  type Plan,
  progressOf,
  refuseOtherPlan,
} from './chunks.ts'
import { claim } from './claim.ts'

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('a plan splits the frames of the window into even chunks of whole frames', () => {
  const job = {
    name: 'j',
    id: 'abc',
    output: { width: 8, height: 8, fps: 30, from: 0, to: 1 },
  } as unknown as Job
  const plan = makePlan(job, 'rgba', 4)
  assert.deepEqual(
    plan.chunks.map((c) => c.frames),
    [8, 7, 8, 7],
  )
  assert.equal(plan.chunks[1]?.from, 8 / 30)
  assert.equal(plan.chunks[3]?.to, 1)
  assert.equal(makePlan(job, 'rgba', 100).chunks.length, 30, 'never more chunks than frames')
})

test('a chunk rendered for another plan is never assembled, even with the same frame count', () => {
  const dir = join(tempDir('plan'), 'plan')
  mkdirSync(dir)
  const job = { name: 'j', id: 'abc', output: { width: 8, height: 8, fps: 4, from: 0, to: 1 } }
  // As renderChunk records a chunk: its file, and beside it what it was rendered for.
  const rendered = (plan: Plan, i: number) => {
    const c = plan.chunks[i] as Plan['chunks'][number]
    writeFileSync(join(dir, c.file), `frames of chunk ${i}`)
    const { file, ...chunk } = c
    const record = { ...chunk, jobId: plan.jobId, input: plan.input, seconds: 0, host: {} }
    writeFileSync(
      `${join(dir, file)}.json`,
      JSON.stringify({ ...record, sha256: sha(join(dir, file)) }),
    )
  }
  // Four chunks of one frame each; chunk 2 is rendered, then the job is planned again in three.
  rendered(makePlan(job as unknown as Job, 'rgba', 4), 2)
  const three = makePlan(job as unknown as Job, 'rgba', 3)
  assert.deepEqual(
    three.chunks.map((c) => c.frames),
    [1, 2, 1],
  )
  rendered(three, 0)
  rendered(three, 1)
  assert.throws(() => checkChunks(three, dir), /chunk-002\.mkv was rendered for another plan/)
  rendered(three, 2)
  assert.equal(checkChunks(three, dir).length, 3)
})

test("a plan is never written over another job's plan or chunks; the same job's is planned again", () => {
  const out = tempDir('plan-out')
  const dir = join(out, 'base.plan')
  mkdirSync(dir)
  const base = { name: 'base', id: 'b1', output: { width: 8, height: 8, fps: 4, from: 0, to: 1 } }
  const plan = makePlan(base as unknown as Job, 'rgba', 2)
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan))
  writeFileSync(join(dir, 'chunk-000.mkv'), 'frames')
  writeFileSync(join(dir, 'chunk-000.mkv.json'), JSON.stringify({ index: 0, jobId: 'b1' }))
  assert.throws(
    () => refuseOtherPlan(dir, { name: 'rep', id: 'r1' }),
    (e: Error) =>
      e.message.includes("holds job base's plan (1 chunk(s) rendered)") &&
      e.message.includes(`--out ${join(out, 'rep.plan')}`),
  )
  // The same job, or a replaced job of that name, plans again in place.
  refuseOtherPlan(dir, { name: 'base', id: 'b1' })
  refuseOtherPlan(dir, { name: 'base', id: 'b2' })
  // A fresh folder is suggested, never one that holds something.
  mkdirSync(join(out, 'rep.plan'))
  assert.throws(() => refuseOtherPlan(dir, { name: 'rep', id: 'r1' }), /--out .*rep-2\.plan$/)
  // Chunks of another job with no plan beside them.
  const loose = join(out, 'loose')
  mkdirSync(loose)
  writeFileSync(join(loose, 'chunk-001.mkv.json'), JSON.stringify({ index: 1, jobId: 'b1' }))
  assert.throws(
    () => refuseOtherPlan(loose, { name: 'rep', id: 'r1' }),
    /chunks of another job \(b1\)/,
  )
  refuseOtherPlan(loose, { name: 'base', id: 'b1' })
  refuseOtherPlan(join(out, 'none'), { name: 'rep', id: 'r1' })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')), plan)
})

test('the state of every chunk: done, verified, changed, missing, partial and stale, all at once', () => {
  const dir = join(tempDir('plan-status'), 'plan')
  mkdirSync(dir)
  const job = { name: 'j', id: 'abc', output: { width: 8, height: 8, fps: 10, from: 0, to: 1 } }
  const plan = makePlan(job as unknown as Job, 'rgba', 5)
  const rendered = (i: number, o: { jobId?: string; seconds?: number } = {}) => {
    const { file, ...c } = plan.chunks[i] as Plan['chunks'][number]
    writeFileSync(join(dir, file), `frames of chunk ${i}`)
    const record = {
      ...c,
      jobId: o.jobId ?? plan.jobId,
      input: plan.input,
      seconds: o.seconds ?? 1,
    }
    writeFileSync(
      `${join(dir, file)}.json`,
      JSON.stringify({ ...record, host: {}, sha256: sha(join(dir, file)) }),
    )
  }
  rendered(0, { seconds: 4 })
  // Chunk 1 is missing. Chunk 2 changed after it was rendered.
  rendered(2, { seconds: 4 })
  writeFileSync(join(dir, 'chunk-002.mkv'), 'corrupt')
  // Chunk 3 stopped part way: a partial and no record.
  writeFileSync(join(dir, 'chunk-003.mkv.123.partial.mkv'), 'part')
  // Chunk 4 was rendered for another job.
  rendered(4, { jobId: 'other' })
  const statuses = (verify: boolean) => chunkStates(plan, dir, verify).map((s) => s.status)
  assert.deepEqual(statuses(false), ['done', 'missing', 'done', 'partial', 'stale'])
  assert.deepEqual(statuses(true), ['verified', 'missing', 'changed', 'partial', 'stale'])
  const states = chunkStates(plan, dir, true)
  assert.deepEqual(states[3]?.partials, [join(dir, 'chunk-003.mkv.123.partial.mkv')])
  assert.match(states[1]?.fix ?? '', /^shaderera render --job j --chunk 1 --plan /)
  // 2 of 10 frames done, at 2 s a frame: 16 s for the other 8.
  assert.deepEqual(progressOf(plan, states), { done: 2, total: 10, eta: 16 })
  // assemble's check lists every problem, each with the command that fixes it.
  assert.throws(
    () => checkChunks(plan, dir),
    (e: Error) => {
      const lines = e.message.split('\n')
      assert.match(lines[0] ?? '', /^4 problems in the plan/)
      for (const i of [1, 2, 3, 4])
        assert.ok(
          lines.some((l) => l.endsWith(`shaderera render --job j --chunk ${i} --plan ${dir}`)),
          `chunk ${i}: ${e.message}`,
        )
      assert.match(e.message, /chunk-002\.mkv changed after it was rendered/)
      assert.match(e.message, /Chunk 3 is not rendered \(a render of it stopped part way\)/)
      return true
    },
  )
})

test('a chunk is done only with its record; one a live render holds is claimed', () => {
  const dir = join(tempDir('plan-claimed'), 'plan')
  mkdirSync(dir)
  const job = { name: 'j', id: 'abc', output: { width: 8, height: 8, fps: 4, from: 0, to: 1 } }
  const plan = makePlan(job as unknown as Job, 'rgba', 2)
  // A file without its record (a render stopped between its renames) is not rendered.
  writeFileSync(join(dir, 'chunk-000.mkv'), 'frames')
  writeFileSync(join(dir, 'chunk-000.mkv.123.partial.mkv'), 'part')
  const held = claim(dir, 'chunk-001.mkv')
  try {
    const states = chunkStates(plan, dir)
    assert.deepEqual(
      states.map((s) => s.status),
      ['partial', 'claimed'],
    )
    assert.equal(states[1]?.claim?.pid, process.pid)
    assert.equal(states[1]?.fix, undefined)
    assert.throws(() => checkChunks(plan, dir), /chunk-001\.mkv is being rendered by /)
  } finally {
    held.release()
  }
  assert.equal(chunkStates(plan, dir)[1]?.status, 'missing')
})

// A decoder whose stdout another process holds open after it exits (#439): its end never comes.
const heldPipe = fileURLToPath(new URL('../fixtures/held-pipe.ts', import.meta.url))
const tinyPlan = { input: 'rgba', width: 4, height: 2 } as const

test('decodeFrames gives its count of frames from a decoder whose output never ends', async () => {
  const start = performance.now()
  const frames: Uint8Array[] = []
  const command = [process.execPath, heldPipe, 'out', '3', '32', '8000']
  for await (const f of decodeFrames(tinyPlan, 'held.mkv', 3, undefined, { command }))
    frames.push(f)
  assert.equal(frames.length, 3)
  assert.ok(frames.every((f) => f.length === 32 && f[0] === 7))
  assert.ok(performance.now() - start < 5000)
})

test('decodeFrames fails, naming the decoder, when it exits short and its output never ends', async () => {
  const command = [process.execPath, heldPipe, 'out', '1', '32', '8000']
  const start = performance.now()
  await assert.rejects(async () => {
    for await (const _ of decodeFrames(tinyPlan, 'held.mkv', 3, undefined, {
      command,
      grace: 300,
    }));
  }, /ffmpeg exited \(0\) after 1 of the 3 frames of held\.mkv, and its output did not end/)
  assert.ok(performance.now() - start < 5000)
})

test('decodeFrames fails a decoder that gives nothing for the stall seconds', async () => {
  const command = [process.execPath, heldPipe, 'deaf']
  await assert.rejects(async () => {
    for await (const _ of decodeFrames(tinyPlan, 'held.mkv', 3, undefined, {
      command,
      stall: 0.5,
    }));
  }, /ffmpeg gave no frame of held.mkv for 0.5 s: it stalled/)
})
