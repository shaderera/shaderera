import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inside, insideForRead } from './inside.ts'

test('inside keeps paths in the project, also through links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-inside-'))
  const root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), '')
  writeFileSync(join(dir, 'secret.txt'), '')
  symlinkSync(dir, join(root, 'up'), 'junction')
  assert.equal(inside(root, 'src/a.ts'), join(root, 'src', 'a.ts'))
  assert.equal(inside(root, 'out/new/film.mp4'), join(root, 'out', 'new', 'film.mp4'))
  assert.throws(() => inside(root, '../secret.txt'), /outside the project/)
  assert.throws(() => inside(root, join(dir, 'secret.txt')), /outside the project/)
  assert.throws(() => inside(root, 'up/secret.txt'), /through a link/)
  assert.throws(() => inside(root, 'up/not-yet.txt'), /through a link/)
})

test('insideForRead also reads an installed package linked from a store, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-inside-'))
  const root = join(dir, 'project')
  const store = join(dir, 'store', 'node_modules', 'pkg')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'a.wasm'), '')
  writeFileSync(join(dir, 'secret.txt'), '')
  symlinkSync(store, join(root, 'node_modules', 'pkg'), 'junction')
  symlinkSync(dir, join(root, 'node_modules', 'up'), 'junction')
  assert.equal(
    insideForRead(root, 'node_modules/pkg/a.wasm'),
    join(root, 'node_modules', 'pkg', 'a.wasm'),
  )
  assert.throws(() => insideForRead(root, 'node_modules/up/secret.txt'), /through a link/)
  assert.throws(() => inside(root, 'node_modules/pkg/a.wasm'), /through a link/)
})
