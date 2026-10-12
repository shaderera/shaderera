import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Json } from '@shaderera/core'
import { checkTimings, evaluateTimings, track } from './timing.ts'

/** A logo that eases in from x = 0 to 100 over 1 s and holds; a title that appears at 1.5 s. */
const inspect = async (t: number): Promise<Json> => ({
  objects: [
    { id: 'logo', x: 100 * Math.min(1, t) ** 2, pos: [100 * Math.min(1, t), 0] },
    { id: 'title', visible: t >= 1.5 },
  ],
})
const film = { fps: 10, duration: 3 }

test('declared timings hold or fail at the frames they name', async () => {
  const [landed, holds, moves, appears, early] = await evaluateTimings(
    [
      { path: 'objects[id=logo].x', at: 1, equals: 100 },
      { path: 'objects[id=logo].x', from: 1, to: 3, changes: false },
      { path: 'objects[id=logo].x', from: 0, to: 1, changes: true },
      { path: 'objects[id=title].visible', at: 1.5, equals: true },
      { path: 'objects[id=logo].x', at: 0.5, min: 50, note: 'halfway by 0.5 s' },
    ],
    inspect,
    film,
  )
  assert.deepEqual([landed?.ok, holds?.ok, moves?.ok, appears?.ok], [true, true, true, true])
  // to = 3 is the film's end: the window stops at the last frame, 2.9 s.
  assert.match(holds?.detail ?? '', /20 frames from 1 to 3 s/)
  assert.equal(early?.ok, false)
  assert.deepEqual(early?.t, [0.5])
  assert.match(early?.detail ?? '', /25, below 50/)
  const [still] = await evaluateTimings(
    [{ path: 'objects[id=logo].x', from: 0.5, to: 1.2, changes: false }],
    inspect,
    film,
  )
  assert.equal(still?.ok, false)
  assert.equal(still?.t[0], 0.6, 'the first frame that moved')
})

test('a timing that says nothing checkable is refused', () => {
  assert.throws(() => checkTimings([{ path: 'a', at: 1 }]), /what to check/)
  assert.throws(() => checkTimings([{ path: 'a', equals: 1 }]), /a time/)
  assert.throws(() => checkTimings([{ path: 'a', at: 1, changes: true }]), /a window/)
})

test('track gives the curve and its speed per second', async () => {
  const curve = await track(inspect, 'objects[id=logo].pos', { fps: 10, from: 0, to: 0.3 })
  assert.deepEqual(
    curve.map((p) => [p.t, p.value]),
    [
      [0, [0, 0]],
      [0.1, [10, 0]],
      [0.2, [20, 0]],
    ],
  )
  assert.equal(curve[0]?.speed, undefined)
  assert.ok(Math.abs((curve[2]?.speed ?? 0) - 100) < 1e-9)
})
