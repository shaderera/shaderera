import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activity,
  align,
  difference,
  meanChange,
  motionWindow,
  row,
  scaleFrame,
  stepOf,
} from './reference.ts'

const W = 16
const H = 8

/** A grey frame with a white 2×2 square at x (none when x is null). */
const frame = (x: number | null, grey = 40): Uint8Array => {
  const px = new Uint8Array(W * H * 4)
  for (let i = 0; i < px.length; i += 4) px.set([grey, grey, grey, 255], i)
  if (x !== null)
    for (let y = 3; y < 5; y++)
      for (let dx = 0; dx < 2; dx++) px.set([255, 255, 255, 255], (y * W + x + dx) * 4)
  return px
}

/**
 * A square that holds at x 1 until frame `start`, moves right 1 px a frame for 3 frames, 2 px for 3,
 * 1 px to land at x 11 (frame start + 7), and holds.
 */
const film = (frames: number, start: number) => {
  const xs: number[] = []
  for (let i = 0; i < frames; i++) {
    const p = Math.max(0, i - start)
    xs.push(1 + Math.min(10, p < 3 ? p : 3 + (p - 3) * 2))
  }
  return xs.map((x) => frame(x))
}

test('meanChange is the mean |ΔR|, |ΔG|, |ΔB| in levels, over black for transparent pixels', () => {
  assert.equal(meanChange(frame(null, 10), frame(null, 10)), 0)
  assert.equal(meanChange(frame(null, 10), frame(null, 30)), 20)
  // Transparent black and opaque black look the same in an mp4.
  const clear = new Uint8Array(4)
  assert.equal(meanChange(clear, Uint8Array.of(0, 0, 0, 255)), 0)
  assert.throws(() => meanChange(new Uint8Array(4), new Uint8Array(8)), /one size/)
})

test('activity: null first, then the change from each frame before; a still frame is 0', () => {
  const curve = activity(film(14, 4))
  assert.equal(curve[0], null)
  // Still until the move starts at frame 5, still again once it lands.
  assert.deepEqual(curve.slice(1, 5), [0, 0, 0, 0])
  assert.ok((curve[5] as number) > 0)
  assert.equal(curve.at(-1), 0)
  // A two-pixel step changes twice the pixels of a one-pixel one.
  assert.ok(Math.abs((curve[8] as number) - 2 * (curve[5] as number)) < 1e-9)
})

test('motionWindow: the first and last frame that changes, and the peak; null when still', () => {
  const w = motionWindow(activity(film(16, 4)))
  assert.deepEqual(w && { first: w.first, last: w.last, at: w.peak.index }, {
    first: 5,
    last: 11,
    at: 8,
  })
  assert.equal(motionWindow(activity([frame(3), frame(3), frame(3)])), null)
  // Noise under the floor is still.
  assert.equal(motionWindow([null, 0.2, 0.1, 0.3], 0.5), null)
  assert.deepEqual(motionWindow([null, 0.2, 4, 0.3, 2, 0.1], 0.5), {
    first: 2,
    last: 4,
    peak: { index: 2, change: 4 },
  })
})

test('align finds a reference that moves 3 frames later as shift +3, and one earlier as -2', () => {
  const ours = activity(film(20, 4))
  // The reference read 5 frames before the film's first and after its last (lead 5).
  const lead = 5
  const late = activity(film(20 + 2 * lead, 4 + lead + 3))
  const a = align(ours, late, 5, lead)
  assert.equal(a.shift, 3)
  assert.ok((a.correlation as number) > 0.999)
  assert.equal(a.scores.length, 11)
  assert.deepEqual(
    a.scores.map((s) => s.shift),
    [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
  )
  // Every shift has all 19 pairs, the read reaching far enough either way.
  assert.ok(a.scores.every((s) => s.overlap === 19))
  const early = activity(film(20 + 2 * lead, 4 + lead - 2))
  assert.equal(align(ours, early, 5, lead).shift, -2)
  // With no lead, a shift pairs fewer samples, and still finds it.
  assert.equal(align(ours, activity(film(20, 7)), 4).shift, 3)
})

test('align says null when a curve does not move, and refuses a shift that is not whole', () => {
  const still = activity([frame(2), frame(2), frame(2), frame(2), frame(2)])
  const a = align(still, activity(film(5, 1)), 1)
  assert.equal(a.shift, null)
  assert.ok(a.scores.every((s) => s.correlation === null))
  assert.throws(() => align(still, still, 1.5), /whole number/)
  // A tie goes to the smaller shift: a constant-speed curve against itself.
  const ramp = [null, 1, 2, 1, 2, 1, 2, 1, 2]
  assert.equal(align(ramp, ramp, 2).shift, 0)
})

test('scaleFrame: the same size is the frame matted; half the size averages 2×2 blocks', () => {
  const px = Uint8Array.of(255, 0, 0, 0, 10, 20, 30, 255)
  assert.deepEqual([...scaleFrame(px, 2, 1, 2, 1)], [0, 0, 0, 255, 10, 20, 30, 255])
  // Four pixels, 0, 100, 200 and 100: half each way is their mean, 100.
  const four = new Uint8Array(16)
  ;[0, 100, 200, 100].forEach((v, i) => {
    four.set([v, v, v, 255], i * 4)
  })
  assert.deepEqual([...scaleFrame(four, 2, 2, 1, 1)], [100, 100, 100, 255])
  // Twice the size: a flat frame stays flat, and every frame is scaled by the same weights.
  const flat = scaleFrame(frame(null, 77), W, H, W * 2, H * 2)
  assert.equal(flat.length, W * H * 16)
  assert.ok(flat.every((v, i) => v === (i % 4 === 3 ? 255 : 77)))
  assert.deepEqual(scaleFrame(frame(4), W, H, 7, 5), scaleFrame(frame(4), W, H, 7, 5))
})

test('difference is |a − b| per channel, opaque; row sets frames side by side', () => {
  const a = Uint8Array.of(10, 200, 30, 255)
  const b = Uint8Array.of(40, 100, 30, 255)
  assert.deepEqual([...difference(a, b)], [30, 100, 0, 255])
  const r = row([a, b, difference(a, b)], 1, 1)
  assert.deepEqual([...r], [10, 200, 30, 255, 40, 100, 30, 255, 30, 100, 0, 255])
  // Two rows: each row of each frame in turn.
  const two = row(
    [Uint8Array.of(1, 1, 1, 1, 2, 2, 2, 2), Uint8Array.of(3, 3, 3, 3, 4, 4, 4, 4)],
    1,
    2,
  )
  assert.deepEqual([...two], [1, 1, 1, 1, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4])
})

test('stepOf: the step of evenly spaced times, else null', () => {
  assert.equal(stepOf([0, 0.1, 0.2, 0.3]), 0.09999999999999999)
  assert.equal(stepOf([0, 0.1, 0.5]), null)
  assert.equal(stepOf([1]), null)
  assert.equal(stepOf([1, 1]), null)
})
