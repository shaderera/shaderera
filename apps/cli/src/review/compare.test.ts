import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareFrames, deltaE2000, sideBySide } from './compare.ts'

test('deltaE2000 gives the published values (Sharma, Wu and Dalal, test data pairs 1, 7, 17, 25)', () => {
  const pairs: [[number, number, number], [number, number, number], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ]
  for (const [a, b, expected] of pairs) {
    assert.ok(Math.abs(deltaE2000(a, b) - expected) < 1e-4, `${a} ${b}: ${deltaE2000(a, b)}`)
    assert.ok(Math.abs(deltaE2000(b, a) - expected) < 1e-4)
  }
})

test('compareFrames: the same frames are infinitely close; a changed pixel is measured', () => {
  const a = new Uint8Array([200, 40, 40, 255, 10, 10, 10, 255])
  const same = compareFrames(a, a.slice())
  assert.equal(same.psnr, Number.POSITIVE_INFINITY)
  assert.equal(same.deltaE, 0)
  assert.equal(same.differing, 0)
  const b = a.slice()
  b[0] = 190
  const r = compareFrames(a, b)
  // One channel of six off by 10: MSE 100 / 6.
  assert.ok(Math.abs(r.psnr - 10 * Math.log10((255 * 255 * 6) / 100)) < 1e-9)
  assert.equal(r.differing, 1)
  assert.ok(r.maxDeltaE > 0 && Math.abs(r.deltaE - r.maxDeltaE / 2) < 1e-9)
})

test('compareFrames sees frames matted over black: a transparent pixel is black', () => {
  const clear = new Uint8Array([255, 255, 255, 0])
  const black = new Uint8Array([0, 0, 0, 255])
  assert.equal(compareFrames(clear, black).psnr, Number.POSITIVE_INFINITY)
})

test('sideBySide puts the first frame on the left, row by row', () => {
  const a = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2])
  const b = new Uint8Array([3, 3, 3, 3, 4, 4, 4, 4])
  assert.deepEqual([...sideBySide(a, b, 1, 2)], [1, 1, 1, 1, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4])
})
