import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCanvas, Path2D, type SKRSContext2D } from '@napi-rs/canvas'
import { fixFullTurns } from './arcs.ts'

fixFullTurns()

const canvas = createCanvas(100, 100)
const ctx = canvas.getContext('2d')
/** How many pixels have any alpha after `path` is filled (or stroked 4 px wide). */
const drawn = (path: (c: SKRSContext2D) => void, paint: 'fill' | 'stroke' = 'fill'): number => {
  ctx.clearRect(0, 0, 100, 100)
  ctx.beginPath()
  ctx.lineWidth = 4
  path(ctx)
  ctx[paint]()
  const data = ctx.getImageData(0, 0, 100, 100).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++
  return n
}
const P = Math.PI
// A filled circle of radius 30 covers about 2827 pixels.
const DISC = 2700

test('a full turn from -π/2 (a progress ring at its end) draws its whole circle', () => {
  assert.ok(drawn((c) => c.arc(50, 50, 30, -P / 2, -P / 2 + 2 * P)) > DISC)
  assert.ok(drawn((c) => c.ellipse(50, 50, 30, 30, 0, -P / 2, -P / 2 + 2 * P)) > DISC)
  // A ring 4 px wide.
  assert.ok(drawn((c) => c.arc(50, 50, 30, -P / 2, 1.5 * P), 'stroke') > 600)
  const path = new Path2D()
  path.arc(50, 50, 30, -P / 2, -P / 2 + 2 * P)
  ctx.clearRect(0, 0, 100, 100)
  ctx.fill(path)
  assert.equal(ctx.getImageData(50, 50, 1, 1).data[3], 255)
})

test('every start draws a full turn, both ways, just short of 2π, at 2π and past it', () => {
  const empty: string[] = []
  for (let i = -2000; i <= 2000; i += 7) {
    const s = i * 0.00731
    for (const ccw of [false, true])
      for (const sweep of [2 * P - 1e-6, 2 * P, 3 * P])
        if (drawn((c) => c.arc(50, 50, 30, s, ccw ? s - sweep : s + sweep, ccw)) < DISC)
          empty.push(`${s}${ccw ? ' ccw' : ''} sweep ${sweep}`)
  }
  assert.deepEqual(empty, [])
})

test('an arc short of a full turn is drawn as given', () => {
  // A half disc: about half the pixels.
  const half = drawn((c) => c.arc(50, 50, 30, 0, P))
  assert.ok(half > 1300 && half < 1500, `${half}`)
})
