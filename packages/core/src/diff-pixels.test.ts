import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffPixels } from './diff-pixels.ts'

test('diffPixels measures differences', () => {
  const a = new Uint8Array([0, 0, 0, 255, 10, 10, 10, 255])
  const b = new Uint8Array([4, 0, 0, 255, 10, 10, 10, 255])
  assert.deepEqual(diffPixels(a, b), {
    pixels: 2,
    differing: 1,
    max: 4,
    mean: 0.5,
    channels: [2, 0, 0, 0],
  })
  assert.equal(diffPixels(a, b, { threshold: 4 }).differing, 0)
  assert.throws(() => diffPixels(a, new Uint8Array(4)))
})
