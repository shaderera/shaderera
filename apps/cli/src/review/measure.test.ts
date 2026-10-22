import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Json } from '@shaderera/core'
import {
  blankTimes,
  captionStats,
  captionsOver,
  endHold,
  excerpt,
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

const tree: Json = {
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

/** Three captions: English, two lines of Thai (18 grapheme clusters, 22 UTF-16 units) and one overlapping it. */
const CAPTIONS = [
  { start: 0, end: 2, text: 'Hello world' },
  { start: 2.5, end: 3.5, text: 'ส่งตรงจากสวน\nถึงบ้านคุณ' },
  { start: 3.4, end: 5, text: 'Bye' },
]

test('captionStats: cps, duration, gap, lines and longest line in grapheme clusters, overlaps', () => {
  const s = captionStats(CAPTIONS)
  assert.deepEqual(
    s.map((c) => [c.index, c.duration, c.cps, c.gap, c.lines, c.longestLine, c.overlaps]),
    [
      [1, 2, 5.5, 0.5, 1, 11, []],
      [2, 1, 18, 3.4 - 3.5, 2, 11, [3]],
      [3, 1.6, 3 / 1.6, null, 1, 3, [2]],
    ],
  )
  assert.ok(s.every((c) => c.refused === undefined))
})

test('captionsOver: a declared maxCps fails exactly the caption over it; minGap fails an overlap', () => {
  const s = captionStats(CAPTIONS)
  assert.deepEqual(
    captionsOver(s, { maxCps: 17 }).map((c) => [c.index, c.why]),
    [[2, ['18 cps > 17']]],
  )
  assert.deepEqual(
    captionsOver(s, { minGap: 0.08, maxLines: 1, maxLineChars: 10, minDuration: 1.5 }).map((c) => [
      c.index,
      c.why,
    ]),
    [
      [1, ['a line of 11 characters > 10']],
      [
        2,
        [
          'a line of 11 characters > 10',
          '2 lines > 1',
          '1 s < 1.5 s',
          'overlaps the next by 0.1 s',
        ],
      ],
    ],
  )
  assert.deepEqual(captionsOver(s, {}), [])
})

test('captionStats: an LRC cue ending at Infinity is an open end, not a crash', () => {
  const s = captionStats([
    { start: 0, end: 1, text: 'one' },
    { start: 1, end: Number.POSITIVE_INFINITY, text: 'last' },
  ])
  assert.deepEqual(s[1] && [s[1].end, s[1].duration, s[1].cps, s[1].gap], [null, null, null, null])
  assert.match(s[1]?.refused ?? '', /no end \(end: Infinity, as an LRC/)
  // The refused cue is in no SRT: no gap to it.
  assert.equal(s[0]?.gap, null)
  assert.deepEqual(
    captionsOver(s, { maxCps: 1, minDuration: 5 }).map((c) => c.index),
    [1],
  )
})

test('excerpt: whole copy when it fits, else cut at a word boundary with an ellipsis', () => {
  assert.equal(excerpt('  Hi\n there ', 30), 'Hi there')
  assert.equal(
    excerpt('This third caption runs far too long to read', 30),
    'This third caption runs far…',
  )
  assert.equal(excerpt('One, two, three, four, five', 12), 'One, two…')
  // Thai has no spaces between words, and still breaks between them.
  assert.equal(excerpt('ส่งตรงจากสวนถึงบ้านคุณทุกวัน', 13), 'ส่งตรงจากสวน…')
  // One word longer than the limit: no boundary to cut at, quoted whole.
  assert.equal(excerpt('Supercalifragilistic', 10), 'Supercalifragilistic')
  // A first word longer than the limit: that word whole, then an ellipsis, never the whole text.
  assert.equal(
    excerpt('Donaudampfschifffahrtsgesellschaftskapitän und noch sehr viele weitere Worte …', 30),
    'Donaudampfschifffahrtsgesellschaftskapitän…',
  )
})
