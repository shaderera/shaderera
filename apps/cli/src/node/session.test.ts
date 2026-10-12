import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notProject } from './session.ts'

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
