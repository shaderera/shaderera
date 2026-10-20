import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import type { Job } from '../project/jobs.ts'
import { checkChunks, makePlan, type Plan } from './chunks.ts'

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
