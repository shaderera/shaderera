import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Job } from '../project/jobs.ts'
import { checkChunks, makePlan, type Plan } from './chunks.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })
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
  const dir = join(mkdtempSync(join(tmpdir(), 'shaderera-plan-')), 'plan')
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

test('chunks rendered apart and assembled give the very file one render gives', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-chunks-'))
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  // ProRes; an mp4's chunks are checked the same way in reuse.test.ts.
  assert.equal(cli(root, 'job', '--name', 'p', '--format', 'prores-hq').status, 0)
  const single = join(root, 'out', 'single.mov')
  const one = cli(root, 'render', '--job', 'p', '--out', single)
  assert.equal(one.status, 0, one.stderr)
  assert.equal(cli(root, 'plan', '--job', 'p', '--chunks', '3').status, 0)
  // Out of order, as separate machines would finish.
  for (const i of ['2', '0', '1'])
    assert.equal(cli(root, 'render', '--job', 'p', '--chunk', i).status, 0)
  const plan = join(root, 'out', 'p.plan')
  const together = join(root, 'out', 'together.mov')
  const a = cli(root, 'assemble', '--plan', plan, '--out', together)
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /10 frames from 3 chunks/)
  assert.equal(sha(together), sha(single), 'the same bytes')
  // A chunk changed after it was rendered is refused.
  writeFileSync(join(plan, 'chunk-001.mkv'), 'x')
  assert.match(cli(root, 'assemble', '--plan', plan).stderr, /chunk-001\.mkv changed/)
})
