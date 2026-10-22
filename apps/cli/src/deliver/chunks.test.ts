import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import type { Job } from '../project/jobs.ts'
import { checkChunks, makePlan, type Plan, refuseOtherPlan } from './chunks.ts'

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
