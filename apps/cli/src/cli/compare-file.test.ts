import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type CompareFileReport,
  onSheet,
  rateTimes,
  referenceFrame,
  summaryLines,
  varyingRate,
} from './compare-file.ts'

const round6 = (t: number) => Number(t.toFixed(6))

test('referenceFrame reads frame i at i / fps, exact or written to 6 decimals, at any fps (#664)', () => {
  for (const fps of [10, 24, 25, 30, 60, 24000 / 1001, 30000 / 1001, 120]) {
    for (let i = 0; i < 300; i++) {
      assert.equal(referenceFrame(i / fps, fps), i, `${fps} fps, frame ${i}`)
      assert.equal(referenceFrame(round6(i / fps), fps), i, `${fps} fps, frame ${i} rounded`)
      // Read through an offset written to 6 decimals: one frame later.
      assert.equal(referenceFrame(i / fps + round6(1 / fps), fps), i + 1, `${fps} fps, +1`)
    }
    // Halfway between two frames is the earlier one; before 0 is no frame.
    assert.equal(referenceFrame(2.5 / fps, fps), 2)
    assert.equal(referenceFrame(-0.5 / fps, fps), -1)
  }
})

test('rateTimes: from + i / fps, unrounded, up to before to', () => {
  const times = rateTimes(0, 1, 30)
  assert.equal(times.length, 30)
  assert.equal(times[1], 1 / 30)
  assert.deepEqual(rateTimes(0.2, 0.5, 10).map(round6), [0.2, 0.3, 0.4])
})

test('summaryLines writes the aligned offset as --offset=<s>, which a negative one needs', () => {
  const report = {
    reference: {
      file: 'r.mp4',
      width: 64,
      height: 36,
      fps: 30,
      duration: 2,
      bits: 8,
      colour: { matrix: 'bt709', range: 'limited', chroma: 'left' },
      timing: 'constant',
    },
    scaled: null,
    region: null,
    step: round6(1 / 30),
    floor: 0,
    offset: {
      applied: 0,
      found: { steps: -6, seconds: round6(-6 / 30), correlation: 0.99 },
      maxShift: 30,
      scores: [],
    },
    window: { film: null, reference: null },
    frames: [],
  } satisfies CompareFileReport
  const line = summaryLines(report).at(-1) as string
  assert.match(line, /align best at -6 steps of 0\.033 s .*Aligned: --offset=-0\.2$/)
})

test('varyingRate: frames within half a frame of i / fps are constant; others are named', () => {
  const at30 = Array.from({ length: 90 }, (_, i) => 0.1 + Math.round((i / 30) * 1000) / 1000)
  assert.equal(varyingRate(at30, 30), undefined)
  assert.equal(varyingRate([], 30), undefined)
  // A screen recording's frames: 30 fps by its tag, one frame held twice as long.
  const held = [0, 1 / 30, 3 / 30, 4 / 30]
  assert.equal(varyingRate(held, 30), 'frame 2 at 0.1 s, not 0.066667 s at 30 fps')
  assert.equal(varyingRate([0, null, 2 / 30], 30), 'frame 1 has no time')
})

test('onSheet keeps every time when they fit, else 64 spread evenly from the first to the last', () => {
  assert.equal(Array.from({ length: 64 }, (_, i) => onSheet(i, 64)).filter(Boolean).length, 64)
  const kept = Array.from({ length: 300 }, (_, i) => i).filter((i) => onSheet(i, 300))
  assert.equal(kept.length, 64)
  assert.equal(kept[0], 0)
  assert.equal(kept.at(-1), 299)
})
