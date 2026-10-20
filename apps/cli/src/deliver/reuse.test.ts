import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameTimes } from '@shaderera/core'
import { changedSpans } from './reuse.ts'

test('a changed span widens to whole frames, then forward by the lookback or to the end', () => {
  const times = frameTimes(10, 1, 4)
  // Frames of the window: 0 is t 1 s. 1.55–1.65 s meets the frames at 1.5 and 1.6 s.
  assert.deepEqual(changedSpans('1.55-1.65', times, 10, undefined), [[5, 6]])
  assert.deepEqual(changedSpans('2-2.5,0-1.05', times, 10, 3), [
    [10, 17],
    [0, 3],
  ])
  assert.deepEqual(changedSpans('2-2.1', times, 10, true), [[10, 29]])
  assert.deepEqual(changedSpans('5-6', times, 10, undefined), [], 'outside the window')
  assert.throws(() => changedSpans('2.5-2', times, 10, undefined), /from-to/)
})
