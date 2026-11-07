import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shrink } from './services.ts'

test('the player shrinks a clip asked at a maxSize by area average in integers, rows then columns, each pass rounding half up (#507)', () => {
  // 3 → 2 across: the middle sample counts a third into each side.
  assert.deepEqual(shrink(new Uint8Array([0, 3, 7]), 3, 1, 1, 2, 1), new Uint8Array([1, 6]))
  // 2×2 → 1×1: rows 1.5 → 2 and 3.5 → 4, then 3.
  assert.deepEqual(shrink(new Uint8Array([1, 2, 3, 4]), 2, 2, 1, 1, 1), new Uint8Array([3]))
  // Each of RGBA's samples on its own; 10-bit planes stay 16-bit.
  assert.deepEqual(
    shrink(new Uint8Array([255, 0, 10, 255, 0, 255, 20, 255]), 2, 1, 4, 1, 1),
    new Uint8Array([128, 128, 15, 255]),
  )
  const deep = shrink(new Uint16Array([1023, 1021, 0, 2]), 4, 1, 1, 2, 1)
  assert.ok(deep instanceof Uint16Array)
  assert.deepEqual(deep, new Uint16Array([1022, 1]))
})
