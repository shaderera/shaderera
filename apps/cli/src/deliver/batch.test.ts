import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { outputRequirements, requiredChecks } from '../project/requirements.ts'
import { batchJobs, shareHosts } from './batch.ts'

const fixture = (name: string) => {
  const root = tempDir(name)
  cpSync(fileURLToPath(new URL(`../cli/fixtures/${name}/`, import.meta.url)), root, {
    recursive: true,
  })
  return root
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

test('a batch shares its hosts: one each while they last, then the rest to the outputs that want more', () => {
  assert.deepEqual(shareHosts([4, 4], 4), [2, 2])
  // A sequential source keeps its one host; the other output takes the rest.
  assert.deepEqual(shareHosts([1, 4], 4), [1, 3])
  assert.deepEqual(shareHosts([4, 4, 4], 4), [2, 1, 1])
  // More outputs than hosts: the later ones wait for a host.
  assert.deepEqual(shareHosts([4, 4, 4, 4, 4], 3), [1, 1, 1, 0, 0])
  assert.deepEqual(shareHosts([1, 1], 4), [1, 1])
})

test('a batch names a job by its variant made safe for a file name (16:9)', async () => {
  const root = fixture('mcp')
  const file = join(root, 'shaderera.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...manifest, variants: { '16:9': { duration: 0.5 } } }))
  const jobs = await batchJobs(root, { batch: 'r', variants: ['16:9'], delivery: {} })
  assert.deepEqual(
    jobs.map((j) => [j.name, j.variant]),
    [['r-16_9', '16:9']],
  )
})
