import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createJob, JobExists, listJobs, readJob } from './jobs.ts'

const fixture = fileURLToPath(new URL('../cli/fixtures/mcp/', import.meta.url))

/** The MCP fixture (a red box; a 0.5 s `short` variant) with one param, in a fresh folder. */
const project = () => {
  const root = join(mkdtempSync(join(tmpdir(), 'shaderera-job-')), 'film')
  cpSync(fixture, root, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  manifest.params = {
    type: 'object',
    properties: { color: { type: 'string', default: 'rgb(255, 0, 0)' } },
  }
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify(manifest))
  const src = join(root, 'src', 'composition.ts')
  writeFileSync(
    src,
    readFileSync(src, 'utf8')
      .replace('({ io }) =>', '({ io, params }) =>')
      .replace("ctx.fillStyle = 'rgb(255, 0, 0)'", 'ctx.fillStyle = params.color as string'),
  )
  return root
}

test('a job resolves the variant and complete params against its revision, and refuses typos', async () => {
  const root = project()
  const job = await createJob(root, { by: 'cli', variant: 'short', params: { color: 'blue' } })
  assert.equal(job.output.to, 0.5)
  assert.deepEqual(job.params, { color: 'blue' })
  assert.equal(job.camera, 'authored')
  assert.deepEqual(readJob(root, job.name), job)
  assert.equal(listJobs(root).length, 1)
  await assert.rejects(
    createJob(root, { by: 'cli', params: { colour: 'blue' } }),
    /Unknown params: colour/,
  )
  await assert.rejects(createJob(root, { by: 'cli', variant: 'tall' }), /no variant "tall"/)
})

test('a job is always a readable file, of at least one frame', async () => {
  const root = project()
  const file = join(root, 'shaderera.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...manifest, variants: { '16:9 cut': { duration: 0.5 } } }))
  // The default name starts with the variant, made a file name.
  const job = await createJob(root, { by: 'cli', variant: '16:9 cut' })
  assert.match(job.name, /^16_9_cut-/)
  assert.deepEqual(
    listJobs(root).map((j) => j.variant),
    ['16:9 cut'],
  )
  // At 10 fps, 0.01 s holds no frame.
  await assert.rejects(createJob(root, { by: 'cli', from: 0.01, to: 0.02 }), /holds no frame/)
})

test('a job name never changes meaning: different delivery gets its own job, a taken name is refused', async () => {
  const root = project()
  const review = await createJob(root, { by: 'cli' })
  const master = await createJob(root, {
    by: 'cli',
    revision: review.revision,
    delivery: { format: 'png', quality: 'master' },
  })
  assert.notEqual(master.name, review.name)
  assert.equal(readJob(root, review.name).delivery.format, 'mp4')
  assert.equal(readJob(root, master.name).delivery.format, 'png')
  // The same inputs again return the job already there.
  const again = await createJob(root, { by: 'cli', revision: review.revision })
  assert.equal(again.name, review.name)
  assert.equal(again.created, review.created)
  // An explicit name holding different inputs is refused, unless replaced on purpose.
  await createJob(root, { by: 'cli', revision: review.revision, name: 'approved' })
  await assert.rejects(
    createJob(root, {
      by: 'cli',
      revision: review.revision,
      name: 'approved',
      delivery: { format: 'png' },
    }),
    JobExists,
  )
  assert.equal(readJob(root, 'approved').delivery.format, 'mp4')
  const replaced = await createJob(root, {
    by: 'cli',
    revision: review.revision,
    name: 'approved',
    delivery: { format: 'png' },
    replace: true,
  })
  assert.equal(readJob(root, 'approved').id, replaced.id)
  // Two writers racing for one name: one wins, the other is refused, nothing is half-written.
  const race = await Promise.allSettled(
    (['mp4', 'png'] as const).map((format) =>
      createJob(root, {
        by: 'cli',
        revision: review.revision,
        name: 'race',
        delivery: { format },
      }),
    ),
  )
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1)
  assert.ok(readJob(root, 'race'))
  // A job edited by hand no longer matches its id and is refused.
  const file = join(root, 'versions', 'jobs', 'approved.json')
  writeFileSync(file, readFileSync(file, 'utf8').replace('"png"', '"mp4"'))
  assert.throws(() => readJob(root, 'approved'), /changed by hand/)
})
