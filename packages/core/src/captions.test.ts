import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toSrt, toVtt, windowCaptions } from './captions.ts'

const cues = [
  { start: 4, end: 6.5, text: 'Second <b> & --> end' },
  { start: 0.5, end: 2, text: 'First\n\nline' },
  { start: 9, end: 12, text: 'Past the cut' },
  { start: 7, end: 8, text: '  ' },
]

test('captions are cut to the window, shifted to start at 0 and sorted; empty ones dropped', () => {
  assert.deepEqual(windowCaptions(cues, 1, 10), [
    { start: 0, end: 1, text: 'First\n\nline' },
    { start: 3, end: 5.5, text: 'Second <b> & --> end' },
    { start: 8, end: 9, text: 'Past the cut' },
  ])
  assert.throws(() => windowCaptions([{ start: 2, end: 1, text: 'x' }], 0, 5), /Caption 0/)
})

test('SRT and WebVTT carry the times to the millisecond and keep cues whole', () => {
  const w = windowCaptions(cues, 0, 10)
  assert.equal(
    toSrt(w).split('\n\n')[0],
    '1\n00:00:00,500 --> 00:00:02,000\nFirst\nline',
    'a blank line inside a cue would end it',
  )
  const vtt = toVtt(w)
  assert.ok(vtt.startsWith('WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nFirst\nline\n'))
  assert.ok(vtt.includes('Second &lt;b> &amp; --&gt; end'))
  assert.ok(vtt.includes('00:00:09.000 --> 00:00:10.000\nPast the cut'))
})
