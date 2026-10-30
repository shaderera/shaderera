import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseParam, timesOf } from './args.ts'
import { stillTimes } from './still.ts'

test('stillTimes takes the given times and adds one every `every` seconds', () => {
  assert.deepEqual(stillTimes([1.5, 4], undefined, 10), [1.5, 4])
  assert.deepEqual(stillTimes([], 2.5, 10), [0, 2.5, 5, 7.5])
  assert.deepEqual(stillTimes([9], 5, 10), [9, 0, 5])
})

test('stillTimes adds count times evenly from --from up to before --to', () => {
  assert.deepEqual(
    stillTimes([], undefined, 10, { count: 12, from: 2, to: 8 }),
    [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5],
  )
  assert.deepEqual(stillTimes([], undefined, 10, { count: 4 }), [0, 2.5, 5, 7.5])
  assert.throws(() => stillTimes([], undefined, 10, { count: 0 }), /--count is a whole number/)
  assert.throws(() => stillTimes([], undefined, 10, { count: 2, from: 5, to: 5 }), /not before/)
  assert.throws(
    () => stillTimes([], undefined, 10, { count: 2, from: 11, to: 12 }),
    /Outside the film/,
  )
})

test('stillTimes refuses no time, a non-number and a time outside the film', () => {
  assert.throws(() => stillTimes([], undefined, 10), /Usage: shaderera still/)
  assert.throws(() => timesOf(['soon']), /Not a time in seconds: soon/)
  assert.throws(() => stillTimes([10], undefined, 10), /Outside the film \(0 to 10 s\): 10/)
  assert.throws(() => stillTimes([], 0, 10), /--every needs seconds above 0/)
})

test('parseParam reads JSON values and keeps anything else as a string', () => {
  assert.deepEqual(parseParam('count=4096'), ['count', 4096])
  assert.deepEqual(parseParam('look=ascii'), ['look', 'ascii'])
  assert.deepEqual(parseParam('tint=[1,0.5,0]'), ['tint', [1, 0.5, 0]])
  assert.throws(() => parseParam('=1'), /key=value/)
})
