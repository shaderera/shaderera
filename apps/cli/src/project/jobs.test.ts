import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256 } from '@shaderera/core/host'
import { buildForNode } from '../node/build.ts'
import { openChild } from '../node/child.ts'
import { findProject } from '../node/project.ts'
import {
  ChangedEnvironment,
  createJob,
  JobExists,
  listJobs,
  openJob,
  readJob,
  verifyJob,
} from './jobs.ts'

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

const render = async (o: Awaited<ReturnType<typeof openJob>>, t = 0.2) => {
  try {
    return await o.child.render(t, 'final')
  } finally {
    await o.child.close()
  }
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

test('a job renders its frozen revision with its own params, whatever the project became', async () => {
  const root = project()
  const job = await createJob(root, { by: 'cli', params: { color: 'rgb(0, 0, 255)' } })
  const before = await sha256((await render(await openJob(root, job))).pixels)
  // The source changes after the job was made: the job still renders what was approved.
  const src = join(root, 'src', 'composition.ts')
  writeFileSync(src, readFileSync(src, 'utf8').replace('ctx.fillRect(', 'ctx.fillRect(1 + '))
  assert.equal(await sha256((await render(await openJob(root, job))).pixels), before)
  // So does an edit to the revision's frozen copy: it is repaired before the job renders.
  const copy = join(root, '.shaderera', 'revisions', job.revision, 'src', 'composition.ts')
  writeFileSync(copy, readFileSync(src, 'utf8'))
  assert.equal(await sha256((await render(await openJob(root, job))).pixels), before)
  // The working tree with the same params now renders something else.
  const now = await findProject(root)
  const child = await openChild(now, { entryFile: await buildForNode(now), params: job.params })
  const live = await child.render(0.2, 'final')
  await child.close()
  assert.notEqual(await sha256(live.pixels), before)
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

test('a job refuses to render when an installed package it executes changed', async () => {
  const root = project()
  // A local package the source imports, as a dependency: it sets the red channel.
  const pkg = join(root, 'node_modules', 'audit-color')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'audit-color', version: '1.0.0', type: 'module', main: 'index.js' }),
  )
  writeFileSync(join(pkg, 'index.js'), 'export const red = 10\n')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'film', private: true, dependencies: { 'audit-color': '1.0.0' } }),
  )
  const src = join(root, 'src', 'composition.ts')
  writeFileSync(
    src,
    `import { red } from 'audit-color'\n${readFileSync(src, 'utf8').replace(
      'ctx.clearRect(0, 0, 64, 36)',
      'ctx.fillStyle = `rgb(${red}, 0, 0)`\n      ctx.fillRect(0, 0, 64, 36)',
    )}`,
  )
  const job = await createJob(root, { by: 'cli' })
  assert.match(Object.keys(job.inputs.packages).join(), /audit-color@1\.0\.0/)
  const frame = await render(await openJob(root, job))
  assert.deepEqual([...frame.pixels.subarray(0, 4)], [10, 0, 0, 255])
  // The same version, different code: the job refuses instead of rendering 200 under its name.
  writeFileSync(join(pkg, 'index.js'), 'export const red = 200\n')
  await assert.rejects(openJob(root, job), (e: unknown) => {
    assert.ok(e instanceof ChangedEnvironment)
    assert.match(e.message, /audit-color@1\.0\.0 has different contents/)
    return true
  })
  await assert.rejects(verifyJob(root, job), ChangedEnvironment)
  // A new job from the same revision renders with what is installed now.
  const now = await createJob(root, { by: 'cli', revision: job.revision })
  assert.notEqual(now.id, job.id)
  assert.deepEqual(
    [...(await render(await openJob(root, now))).pixels.subarray(0, 4)],
    [200, 0, 0, 255],
  )
})

test('the first render pins the host; another host is refused', async () => {
  const root = project()
  const job = await createJob(root, { by: 'cli' })
  await render(await openJob(root, job))
  const pin = join(root, 'versions', 'jobs', `${job.name}.host.json`)
  assert.equal(JSON.parse(readFileSync(pin, 'utf8')).host, 'node')
  await render(await openJob(root, job))
  assert.deepEqual(
    listJobs(root).map((j) => j.name),
    [job.name],
  )
  writeFileSync(pin, JSON.stringify({ ...JSON.parse(readFileSync(pin, 'utf8')), adapter: 'other' }))
  await assert.rejects(openJob(root, job), /first rendered on another host.*adapter was "other"/)
  // Replaced by another job under the same name: the old pin goes with the old job.
  await createJob(root, { by: 'cli', name: job.name, replace: true, delivery: { format: 'png' } })
  assert.equal(existsSync(pin), false)
})
