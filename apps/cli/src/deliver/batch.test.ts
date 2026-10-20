import assert from 'node:assert/strict'
import { cpSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { outputRequirements, requiredChecks } from '../project/requirements.ts'
import { batchJobs } from './batch.ts'

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
