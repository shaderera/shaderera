import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dropFrame,
  fpsFraction,
  frameAt,
  frameCount,
  framesOfTimecode,
  frameTimes,
  parseFps,
  timecodeOf,
} from './time.ts'

test('frameTimes is computed from the index and includes a from on a frame', () => {
  assert.deepEqual(frameTimes(30, 0.1, 0.2), [3 / 30, 4 / 30, 5 / 30])
  assert.deepEqual(frameTimes(2, 0, 2), [0, 0.5, 1, 1.5])
  assert.equal(frameCount(30, 1), 30)
  assert.equal(frameCount(30, 0), 0)
})

test('NTSC rates are exact fractions, written either way', () => {
  for (const v of [23.976, 23.98, '24000/1001', ' 24000 / 1001 '])
    assert.deepEqual(parseFps(v), { fps: 24000 / 1001, num: 24000, den: 1001 })
  assert.deepEqual(parseFps(29.97), { fps: 30000 / 1001, num: 30000, den: 1001 })
  assert.deepEqual(parseFps(59.94)?.num, 60000)
  assert.deepEqual(parseFps(25), { fps: 25, num: 25, den: 1 })
  assert.deepEqual(parseFps(12.5), { fps: 12.5, num: 25, den: 2 })
  for (const bad of [0, -24, '24/0', 'fast', null]) assert.equal(parseFps(bad), null)
  assert.equal(fpsFraction(24000 / 1001), '24000/1001')
  assert.equal(fpsFraction(30), '30')
  // A minute at 23.976 is 1438.56 frames: frame 1439 starts after 60 s of clock.
  assert.equal(frameCount(24000 / 1001, 60), 1439)
  assert.equal(frameAt(frameTimes(30000 / 1001, 0, 100)[2997] as number, 30000 / 1001), 2997)
})

test('drop-frame timecode at 29.97 and 59.94; non-drop at 23.976 and whole rates', () => {
  const ntsc = 30000 / 1001
  assert.equal(timecodeOf(0, ntsc), '00:00:00;00')
  assert.equal(timecodeOf(1799, ntsc), '00:00:59;29')
  assert.equal(timecodeOf(1800, ntsc), '00:01:00;02')
  assert.equal(timecodeOf(17982, ntsc), '00:10:00;00')
  // An hour of 29.97 is 107892 frames, and the timecode says one hour.
  assert.equal(timecodeOf(107892, ntsc), '01:00:00;00')
  assert.equal(timecodeOf(3600, 60000 / 1001), '00:01:00;04')
  assert.equal(timecodeOf(1440, 24000 / 1001), '00:01:00:00')
  assert.equal(timecodeOf(90, 30), '00:00:03:00')
  assert.equal(timecodeOf(Math.round(3661.5 * 30), 30), '01:01:01:15')
})

test('a timecode reads back to its frame, drop-frame included', () => {
  for (const fps of [30000 / 1001, 60000 / 1001, 24000 / 1001, 25])
    for (const frame of [0, 1, 1799, 1800, 17982, 107892, 123457])
      assert.equal(framesOfTimecode(timecodeOf(frame, fps), fps), frame, `${fps} ${frame}`)
  assert.equal(framesOfTimecode('10:00:00:00', 25), 900000)
})
