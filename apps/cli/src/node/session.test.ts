import assert from 'node:assert/strict'
import { cpSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { createNodeSession, notProject } from './session.ts'

test('reading a project file keeps the child; editing one reopens it', async () => {
  const root = tempDir('session')
  cpSync(fileURLToPath(new URL('../cli/fixtures/mcp/', import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  const session = createNodeSession(root)
  try {
    const file = join(root, 'src', 'composition.ts')
    const first = (await session.open()).child
    // what a read does on Windows once the access time is an hour old (NTFS last access): the
    // access time moves, the content and the modified time do not
    utimesSync(file, new Date(), statSync(file).mtime)
    await sleep(300)
    assert.equal((await session.open()).child, first, 'a read reopened the source')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`)
    await sleep(300)
    assert.notEqual((await session.open()).child, first, 'an edit did not reopen the source')
  } finally {
    session.close()
  }
})

test('installs, builds, renders and driver logs do not reopen the source; the project does', () => {
  for (const file of [
    'node_modules/three/build/three.module.js',
    '.shaderera\\node\\entry.js',
    'out/film.mp4',
    'NVIDIA Corporation',
    'NVIDIA Corporation\\umdlogs',
    'versions/log.jsonl',
    '.shaderera/stage/run-1/src/composition.ts',
  ])
    assert.ok(notProject(file), file)
  for (const file of [
    'src/composition.ts',
    'shaderera.json',
    'package.json',
    'outline.ts',
    'versionsNotes.md',
  ])
    assert.ok(!notProject(file), file)
})
