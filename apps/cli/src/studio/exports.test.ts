import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { keepNewestExport } from './exports.ts'

test('a studio export replaces the older one of its variant and format, and nothing else', () => {
  const dir = join(tempDir('studio-out'), 'out', 'studio')
  mkdirSync(dir, { recursive: true })
  const files = [
    'film-0123456789ab.mp4', // an older export of the main cut, mp4: removed
    'film-0123456789ab.png', // another format: kept
    'film-portrait-0123456789ab.mp4', // another variant: kept
    'film-final.mp4', // renamed by the person: kept
    'other-0123456789ab.mp4', // another project's name: kept
  ]
  for (const f of files) writeFileSync(join(dir, f), 'x')
  const newest = join(dir, 'film-ba9876543210.mp4')
  writeFileSync(newest, 'y')
  keepNewestExport(newest)
  assert.deepEqual(readdirSync(dir).sort(), [...files.slice(1), 'film-ba9876543210.mp4'].sort())
  // A variant's export replaces only that variant's.
  const portrait = join(dir, 'film-portrait-ffffffffffff.mp4')
  writeFileSync(portrait, 'z')
  keepNewestExport(portrait)
  assert.ok(!readdirSync(dir).includes('film-portrait-0123456789ab.mp4'))
  assert.ok(readdirSync(dir).includes('film-ba9876543210.mp4'))
})
