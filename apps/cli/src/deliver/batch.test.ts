import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { boxFrame, memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import type { Delivery, Job } from '../project/jobs.ts'
import { outputRequirements, requiredChecks } from '../project/requirements.ts'
import { type BatchOutput, batchJobs, deliverBatch } from './batch.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const fixture = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `shaderera-${name}-`))
  cpSync(fileURLToPath(new URL(`../cli/fixtures/${name}/`, import.meta.url)), root, {
    recursive: true,
  })
  return root
}
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args], { encoding: 'utf8' })
/** A job's film in memory, at its size and length (fixtures/mcp's box): no host opens. */
const inMemory = async (job: Job) => {
  const { width, height, fps, to } = job.output
  return {
    project: memoryProject({ width, height, fps, duration: to }),
    child: memoryChild({ size: { width, height }, frame: boxFrame(width, height) }),
  }
}

test('there is no default safe area: an output is judged only on what requirements.json declares', () => {
  const tall = { width: 1080, height: 1920, fps: 30, duration: 2 }
  assert.equal(outputRequirements({ version: 1 }, tall).safeArea, undefined)
  const declared = { top: 0.14, right: 0.06, bottom: 0.35, left: 0.06 }
  assert.deepEqual(outputRequirements({ version: 1, safeArea: declared }, tall).safeArea, declared)
  assert.deepEqual([...requiredChecks({ version: 1 })].sort(), [
    'assets',
    'build',
    'determinism',
    'requirements',
  ])
  assert.deepEqual(
    [
      ...requiredChecks({
        version: 1,
        endHold: 1,
        readingTime: { min: 0.8, charsPerSecond: 15 },
        textOverlap: 0.1,
        noBlankFrames: true,
        safeArea: declared,
      }),
    ].sort(),
    [
      'assets',
      'blank-frames',
      'build',
      'determinism',
      'end-hold',
      'reading',
      'requirements',
      'text-fit',
      'text-overlap',
    ],
  )
})

test('deliver renders and reviews each variant with its own format and writes the index', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = fixture('mcp')
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1, endHold: 0 }))
  const r = cli('deliver', '--root', root, '--variants', 'short,teaser', '--name', 'b')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stderr, /output 1\/2 b-short\noutput 2\/2 b-teaser/)
  const dir = join(root, 'out', 'deliveries', 'b')
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  assert.deepEqual(
    index.outputs.map((o: { job: string; duration: number; status: string }) => [
      o.job,
      o.duration,
      o.status,
    ]),
    [
      ['b-short', 0.5, 'pass'],
      ['b-teaser', 0.3, 'pass'],
    ],
  )
  for (const o of index.outputs) {
    assert.ok(existsSync(join(dir, o.file)) && o.bytes > 0)
    assert.ok(existsSync(join(dir, o.contactSheet)))
    const format = o.checks.find((c: { id: string }) => c.id === 'format')
    assert.equal(format.status, 'pass', JSON.stringify(format))
  }
  assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /\| pass \| b-teaser \|/)
})

test('an output that fails a required check fails, after the rest are rendered', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = fixture('mcp')
  // An end hold longer than the film: required by the requirements, so it fails the output.
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1, endHold: 60 }))
  const jobs = await batchJobs(root, { batch: 'f', variants: ['short', 'teaser'], delivery: {} })
  const { index } = await deliverBatch(root, jobs, { batch: 'f', open: inMemory })
  assert.equal(index.outputs.length, 2)
  assert.ok(index.outputs.every((o) => o.file && o.status === 'fail'))
})

test('a batch refuses a locale the project does not declare, before rendering', async () => {
  const root = fixture('mcp')
  await assert.rejects(
    batchJobs(root, { batch: 'l', locales: ['en', 'th'], delivery: {} }),
    /Locales need a "locale" param/,
  )
  await assert.rejects(
    batchJobs(fixture('deliver'), { batch: 'l', locales: ['fr'], delivery: {} }),
    /Unknown locale fr: the locale param allows en, th/,
  )
})

test('a batch over variants × locales as png sets the locale param per job', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = fixture('deliver')
  const jobs = await batchJobs(root, {
    batch: 'p',
    variants: ['square'],
    locales: ['en', 'th'],
    delivery: { format: 'png' },
  })
  const { dir, index } = await deliverBatch(root, jobs, { batch: 'p', open: inMemory })
  assert.deepEqual(
    index.outputs.map((o) => [o.job, o.locale, o.format]),
    [
      ['p-square-en', 'en', 'png'],
      ['p-square-th', 'th', 'png'],
    ],
  )
  const d = JSON.parse(readFileSync(join(dir, 'p-square-th', 'delivery.json'), 'utf8'))
  assert.equal(d.params.locale, 'th')
  assert.equal(d.frameCount, 5)
})

test('a declared placement checks the delivered file, and passes once the file is made for it', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = fixture('mcp')
  const silentScreen = {
    name: 'a silent screen',
    containers: ['mp4'],
    videoCodecs: ['h264'],
    audio: 'none',
    maxBitrate: 10_000_000,
    durations: [0.5],
    editList: false,
  }
  writeFileSync(
    join(root, 'requirements.json'),
    JSON.stringify({ version: 1, placements: { short: silentScreen } }),
  )
  const placement = async (batch: string, delivery: Partial<Delivery>, audio?: boolean) => {
    const jobs = await batchJobs(root, { batch, variants: ['short'], delivery })
    const { index } = await deliverBatch(root, jobs, { batch, audio, open: inMemory })
    const output = index.outputs[0] as BatchOutput
    return { status: output.status, check: output.checks.find((c) => c.id === 'placement') }
  }
  const plain = await placement('p1', {})
  assert.equal(plain.status, 'fail')
  assert.equal(plain.check?.status, 'fail')
  assert.match(plain.check?.detail ?? '', /an edit list \(--no-edit-list\)/)
  const made = await placement('p2', { editList: false }, false)
  assert.equal(made.status, 'pass')
  assert.equal(made.check?.status, 'pass')
  assert.match(
    made.check?.measured ?? '',
    /mp4, h264 64×36 10 fps, 0\.5 s, .*no audio, no edit list/,
  )
})

test('deliver spreads an output over several hosts, as render --job does, and closes them', {
  skip: (!ffmpeg && 'no ffmpeg') || (availableParallelism() < 5 && 'fewer than 5 cores'),
}, async () => {
  const root = fixture('mcp')
  // 9 s at 10 fps: 90 frames, 3 hosts by defaultWorkers on 5 cores or more.
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify({ ...manifest, duration: 9 }))
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1, endHold: 0 }))
  const jobs = await batchJobs(root, { batch: 'w', delivery: {} })
  let opened = 0
  let closed = 0
  const host = (job: Job) => {
    const { width, height } = job.output
    const child = memoryChild({ size: { width, height }, frame: boxFrame(width, height) })
    const close = async () => {
      closed++
      await child.close()
    }
    return { ...child, close }
  }
  const { index } = await deliverBatch(root, jobs, {
    batch: 'w',
    open: async (job) => ({
      ...(await inMemory(job)),
      more: async () => (opened++, host(job)),
    }),
  })
  assert.equal(index.outputs[0]?.status, 'pass', JSON.stringify(index.outputs[0]))
  assert.equal(opened, 2)
  assert.equal(closed, 2)
})
