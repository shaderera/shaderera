import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Manifest } from '@shaderera/core'
import { tempDir } from '../fixtures/temp.ts'
import { findProject } from '../node/project.ts'
import { effectiveParams, windowOf } from '../project/jobs.ts'
import { readRequirements } from '../project/requirements.ts'
import { revisionOf, save } from '../project/revisions.ts'
import { crfOf } from './render.ts'
import { variantList } from './variants.ts'

// What PowerShell's `Set-Content -Encoding utf8` puts first.
const BOM = String.fromCharCode(0xfeff)
const film = { entry: './src/composition.ts', fps: 10, duration: 10, width: 64, height: 36 }

test('params: a required one with no value, and a value of another JSON type, are refused', () => {
  const manifest = {
    ...film,
    params: {
      properties: {
        title: { type: 'string' },
        speed: { type: 'number', default: 1 },
        count: { type: 'integer', default: 2 },
      },
      required: ['title'],
    },
  } as unknown as Manifest
  assert.throws(
    () => effectiveParams(manifest, {}),
    /^Error: Missing params: title\. shaderera\.json requires them and gives no default: --param title=<value>\.$/,
  )
  assert.throws(
    () => effectiveParams(manifest, {}, { title: 'x', speed: 'fast' }),
    /^Error: Param speed is a number, not "fast"\.$/,
  )
  assert.throws(
    () => effectiveParams(manifest, {}, { title: 'x', count: 1.5 }),
    /Param count is an integer, not 1\.5\./,
  )
  assert.deepEqual(effectiveParams(manifest, {}, { title: 'x', speed: 3 }), {
    title: 'x',
    speed: 3,
    count: 2,
  })
})

test('--crf is a whole number 0–51', () => {
  assert.equal(crfOf(undefined), undefined)
  assert.equal(crfOf('0'), 0)
  assert.equal(crfOf('51'), 51)
  for (const bad of ['99', 'abc', '-1', '18.5'])
    assert.throws(() => crfOf(bad), /--crf is a whole number 0–51, lower is better/)
})

test('a reversed window says --to must be after --from', () => {
  assert.throws(() => windowOf(film, 2, 1), /^Error: --to must be after --from \(2–1 s\)\.$/)
  assert.throws(() => windowOf(film, 2, 11), /The window 2–11 s is outside 0–10 s\./)
})

test('a revision is its id or a unique prefix of 4 or more; an ambiguous one lists them', () => {
  const root = tempDir('prefix')
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify(film))
  const { id } = save(root, { by: 'cli' })
  assert.equal(revisionOf(root, id), id)
  assert.equal(revisionOf(root, id.slice(0, 4)), id)
  assert.throws(
    () => revisionOf(root, 'ffff'),
    /^Error: No revision ffff \(see shaderera versions\)\.$/,
  )
  const revisions = join(root, 'versions', 'revisions')
  for (const other of ['abcd000000000001', 'abcd000000000002'])
    writeFileSync(join(revisions, `${other}.json`), '{}')
  assert.throws(
    () => revisionOf(root, 'abcd'),
    /^Error: Revision abcd is ambiguous: abcd000000000001, abcd000000000002\. Give more of it\.$/,
  )
})

test('an unknown variant names the declared one it most likely meant', () => {
  const manifest = {
    ...film,
    variants: { 'cover-16x9': { width: 64 }, 'cover-9x16': { width: 36 }, short: { duration: 1 } },
  } as unknown as Manifest
  assert.throws(() => variantList(['16:9'], manifest), /Did you mean cover-16x9\?/)
  assert.throws(() => variantList(['9:16'], manifest), /Did you mean cover-9x16\?/)
  assert.throws(() => variantList(['shrt'], manifest), /Did you mean short\?/)
  assert.throws(
    () => variantList(['zzzzzz'], manifest),
    (e: Error) => !/Did you mean/.test(e.message),
  )
})

test('a shaderera.json and a requirements.json that start with a BOM are read', async () => {
  const root = tempDir('bom')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'shaderera.json'), BOM + JSON.stringify(film))
  writeFileSync(join(root, 'requirements.json'), BOM + JSON.stringify({ version: 1 }))
  assert.equal((await findProject(root)).manifest.fps, 10)
  assert.equal(readRequirements(root).version, 1)
})
