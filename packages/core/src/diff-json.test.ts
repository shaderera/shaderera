import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffJson } from './diff-json.ts'
import type { Json } from './protocol.ts'

test('diffJson ignores key order and finds deep changes', () => {
  assert.deepEqual(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 }), [])
  assert.deepEqual(diffJson({ camera: { eye: [0, 1] } }, { camera: { eye: [2, 1] } }), [
    { path: 'camera.eye[0]', a: 0, b: 2 },
  ])
  assert.deepEqual(diffJson(1, 'x'), [{ path: '', a: 1, b: 'x' }])
  assert.deepEqual(diffJson({ a: 1 }, { b: 1 }), [
    { path: 'a', a: 1 },
    { path: 'b', b: 1 },
  ])
  assert.deepEqual(diffJson([1], [1, 2]), [{ path: '[1]', b: 2 }])
})

test('diffJson compares numbers with tolerance and NaN equal', () => {
  assert.deepEqual(diffJson(1, 1.05, { tolerance: 0.1 }), [])
  assert.equal(diffJson(1, 1.05).length, 1)
  assert.deepEqual(diffJson(Number.NaN, Number.NaN), [])
})

test('diffJson matches arrays of objects by id', () => {
  const a: Json = [{ id: 'stand', x: 1 }, { id: 'lamp' }]
  const b: Json = [{ id: 'chair' }, { id: 'stand', x: 2 }]
  assert.deepEqual(diffJson(a, b), [
    { path: '[id=stand].x', a: 1, b: 2 },
    { path: '[id=lamp]', a: { id: 'lamp' } },
    { path: '[id=chair]', b: { id: 'chair' } },
  ])
})

test('diffJson compares items with a repeated id by index', () => {
  const a = [
    { id: 'a', x: 1 },
    { id: 'a', x: 2 },
  ]
  const b = [
    { id: 'a', x: 9 },
    { id: 'a', x: 2 },
  ]
  assert.deepEqual(diffJson(a, b), [{ path: '[0].x', a: 1, b: 9 }])
})
