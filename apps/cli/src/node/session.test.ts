import assert from 'node:assert/strict'
import { cpSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
    // access time moves, the content and the modified time do not. macOS reports this as a
    // rename, which a move is too: it reopens there, and a read never does it.
    if (process.platform !== 'darwin') {
      utimesSync(file, new Date(), statSync(file).mtime)
      await sleep(300)
      assert.equal((await session.open()).child, first, 'a read reopened the source')
    }
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`)
    await sleep(300)
    assert.notEqual((await session.open()).child, first, 'an edit did not reopen the source')
  } finally {
    session.close()
  }
})

test('files written just before the session opened do not reopen it; a file added after does', async () => {
  const root = tempDir('session')
  cpSync(fileURLToPath(new URL('../cli/fixtures/mcp/', import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  // macOS reports these to the watch that starts right after (#665)
  writeFileSync(join(root, 'poster.json'), '{}')
  await sleep(5)
  const session = createNodeSession(root)
  try {
    const first = (await session.open()).child
    await sleep(300)
    assert.equal((await session.open()).child, first, 'a file written before reopened the source')
    writeFileSync(join(root, 'boxes.json'), '{}')
    await sleep(300)
    const second = (await session.open()).child
    assert.notEqual(second, first, 'an added file did not reopen the source')
    renameSync(join(root, 'poster.json'), join(root, 'moved.json'))
    await sleep(300)
    assert.notEqual((await session.open()).child, second, 'a move did not reopen the source')
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
