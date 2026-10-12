import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blankTimes,
  endHold,
  fontFamilies,
  frameStats,
  layoutSignature,
  meanAbsDiff,
  missingCopy,
  shotsOf,
  textFit,
  textOverlaps,
  textRuns,
} from './measure.ts'

const solid = (n: number, v: number) =>
  new Uint8Array(n * 4).fill(v).map((x, i) => (i % 4 === 3 ? 255 : x))
const noisy = (n: number, seed: number) =>
  new Uint8Array(n * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37 + seed * 11) % 251))

test('blank frames: a flat frame inside the film fails, a flat first frame does not', () => {
  const frames = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5].map((t) => ({
    t,
    std: frameStats(t === 0 || t === 0.75 ? solid(64, 20) : noisy(64, t * 4)).std,
  }))
  assert.deepEqual(blankTimes(frames, 1.5), [0.75])
})

test('end hold: the trailing span of still frames', () => {
  const times = [0, 0.1, 0.2, 0.3, 0.4, 0.5]
  const px = [noisy(16, 1), noisy(16, 2), noisy(16, 3), solid(16, 9), solid(16, 9), solid(16, 9)]
  const diffs = px.map((p, i) => (i === 0 ? 0 : meanAbsDiff(px[i - 1] as Uint8Array, p)))
  assert.ok(Math.abs(endHold(times, diffs) - 0.2) < 1e-9)
  assert.equal(endHold(times, [0, 9, 9, 9, 9, 9]), 0)
})

const tree = {
  shots: [
    { id: 'end', at: 5, label: 'end' },
    { id: 'open', at: 0, label: 'open' },
  ],
  layout: 'landscape',
  blocks: [
    {
      id: 'head',
      role: 'headline',
      text: 'Time,  both\nways.',
      font: 'Noto Sans',
      size: 90,
      box: [100, 100, 800, 100],
      space: 'screen',
    },
    {
      id: 'line',
      role: 'line',
      text: 'Under it',
      font: '84px "Noto Sans Thai", "Noto Sans"',
      box: [120, 180, 400, 60],
    },
    { id: 'gone', text: 'hidden', box: [0, 0, 10, 10], opacity: 0 },
    { nested: { id: 'cta', text: 'Buy', family: 'Noto Sans', box: [1850, 1000, 100, 40] } },
  ],
}

test('text runs, shots, fit, overlap and copy on a synthetic inspect tree', () => {
  const runs = textRuns(tree).map((r) => ({ ...r, t: 1 }))
  assert.deepEqual(
    runs.map((r) => r.id),
    ['head', 'line', 'cta'],
  )
  assert.equal(runs[2]?.font, 'Noto Sans')
  assert.deepEqual(
    shotsOf(tree).map((s) => s.id),
    ['open', 'end'],
  )
  const fit = textFit(runs, 1920, 1080)
  assert.deepEqual(
    fit.outside.map((o) => `${o.id}:${o.side}`),
    ['cta:right'],
  )
  const safe = textFit(runs, 1920, 1080, { top: 0.1, right: 0.05, bottom: 0.05, left: 0.05 })
  assert.ok(safe.outside.some((o) => o.id === 'head' && o.side === 'top'))
  const overlaps = textOverlaps(runs)
  assert.equal(overlaps.length, 1)
  assert.equal(overlaps[0]?.a, 'head')
  assert.ok(Math.abs((overlaps[0]?.fraction ?? 0) - (400 * 20) / (400 * 60)) < 1e-9)
  assert.deepEqual(missingCopy(['Time, both ways.', 'Buy', 'Sell'], runs), ['Sell'])
  assert.deepEqual(fontFamilies('84px "Noto Sans Thai", "Noto Sans"'), [
    'Noto Sans Thai',
    'Noto Sans',
  ])
  assert.deepEqual(fontFamilies('Noto Sans'), ['Noto Sans'])
})

test('the layout is still when text and camera are, whatever the light does', () => {
  const run = {
    id: 'mark',
    text: 'NORTHLIGHT',
    box: [100, 200, 300.4, 40] as [number, number, number, number],
  }
  const camera = { view: [1, 0, 0, 0.30001], projection: [2] }
  const a = layoutSignature([run], camera)
  assert.equal(layoutSignature([{ ...run, box: [100.2, 200, 300.3, 40] }], camera), a)
  assert.notEqual(layoutSignature([{ ...run, box: [104, 200, 300, 40] }], camera), a)
  assert.notEqual(layoutSignature([{ ...run, opacity: 0.5 }], camera), a)
  assert.notEqual(layoutSignature([run], { ...camera, view: [1, 0, 0, 0.31] }), a)
})
