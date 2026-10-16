// text-timed-cues, headless: copied into a project the way `add` lays it out, LRC, SRT, VTT and
// JSON parsed, a file read through a fake host, and the line and the word asked for at t.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'text-timed-cues')
rmSync(project, { recursive: true, force: true })
mkdirSync(project, { recursive: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'text-timed-cues', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) cpSync(join(plugins, 'text-timed-cues', f), join(project, f))
const {
  cueAt,
  loadTimedText,
  parseLrc,
  parseSrt,
  parseTimedJson,
  parseTimedText,
  trimCues,
  wordAt,
} = (await import(
  pathToFileURL(join(project, 'src/type/timed-text.ts')).href
)) as typeof import('../text-timed-cues/src/type/timed-text.ts')

test('text-timed-cues: LRC, with repeated lines, word times and an offset', () => {
  const lrc = parseLrc(
    [
      '[ar:Someone]',
      '[00:01.50]first line',
      '[00:04.00][00:20.00]chorus',
      '[00:06.00]<00:06.00>one <00:06.40>two <00:07.10>',
    ].join('\n'),
  )
  assert.deepEqual(
    lrc.map((c) => [c.start, c.end, c.text]),
    [
      [1.5, 4, 'first line'],
      [4, 6, 'chorus'],
      [6, 20, 'one two'],
      [20, Number.POSITIVE_INFINITY, 'chorus'],
    ],
  )
  assert.deepEqual(lrc[2]?.words, [
    { start: 6, end: 6.4, text: 'one' },
    { start: 6.4, end: 7.1, text: 'two' },
  ])
  assert.equal(parseLrc('[offset:+500]\n[00:01.00]late')[0]?.start, 1.5)
  // A last word with no closing time ends with its line.
  assert.equal(parseLrc('[00:01.00]<00:01.00>a <00:01.50>b\n[00:03.00]')[0]?.words?.[1]?.end, 3)
})

test('text-timed-cues: SRT and WebVTT, tags stripped, gaps kept', () => {
  const srt = parseSrt(
    [
      '1',
      '00:00:01,000 --> 00:00:02,500',
      '<i>Hello</i>',
      'there',
      '',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      'Bye',
    ].join('\n'),
  )
  assert.deepEqual(srt, [
    { start: 1, end: 2.5, text: 'Hello\nthere' },
    { start: 3, end: 4, text: 'Bye' },
  ])
  assert.equal(cueAt(srt, 2.7), undefined)
  assert.equal(cueAt(trimCues(srt, 1), 2.2)?.text, 'Bye')
  const vtt = parseTimedText(
    'a.vtt',
    'WEBVTT\n\nNOTE skipped\n\nintro\n00:01.000 --> 00:02.000 align:start\nHi\n',
  )
  assert.deepEqual(vtt, [{ start: 1, end: 2, text: 'Hi' }])
})

test('text-timed-cues: JSON rows and Whisper segments, the word at t', () => {
  assert.deepEqual(
    parseTimedJson([
      [2, 3, ' b '],
      [0.5, 1.5, 'a'],
    ]).map((c) => c.text),
    ['a', 'b'],
  )
  const whisper = parseTimedJson({
    segments: [
      {
        start: 1,
        end: 2,
        text: ' hi you',
        words: [
          { start: 1, end: 1.4, word: ' hi' },
          { start: 1.5, end: 2, word: ' you' },
        ],
      },
    ],
  })
  assert.equal(whisper[0]?.text, 'hi you')
  assert.equal(wordAt(whisper, 0.9), undefined)
  assert.equal(wordAt(whisper, 1.45)?.text, 'hi')
  assert.equal(wordAt(whisper, 1.6)?.text, 'you')
  assert.throws(() => parseTimedJson({}), /Whisper segments/)
  assert.throws(() => parseTimedText('a.txt', ''), /\.lrc, \.srt, \.vtt or \.json/)
})

test('text-timed-cues: a transcript with top-level words (Paxa Labs STT) is one cue', () => {
  const paxa = parseTimedText(
    'vo.paxa.json',
    JSON.stringify({
      text: 'ทุกคนรู้กันไหม',
      words: [
        { text: 'ทุก', start: 0.12, end: 0.24 },
        { text: 'คน', start: 0.24, end: 0.5 },
        { text: 'รู้', start: 0.6, end: 0.8 },
        { text: 'กันไหม', start: 0.8, end: 1.3 },
      ],
      subtitles: '1\n00:00:00,120 --> 00:00:01,300\nทุกคนรู้กันไหม\n',
    }),
  )
  assert.deepEqual(
    paxa.map((c) => [c.start, c.end, c.text, c.words?.length]),
    [[0.12, 1.3, 'ทุกคนรู้กันไหม', 4]],
  )
  assert.equal(wordAt(paxa, 0.3)?.text, 'คน')
  assert.equal(wordAt(paxa, 0.55)?.text, 'คน')
  assert.equal(wordAt(paxa, 1.3), undefined)
  assert.equal(wordAt(parseTimedJson({ words: [{ word: 'a', start: 1 }] }), 1)?.text, 'a')
  assert.deepEqual(parseTimedJson({ words: [] }), [])
})

test('text-timed-cues: loadTimedText reads a project file by its extension, trimmed', async () => {
  mkdirSync(join(project, 'lyrics'), { recursive: true })
  writeFileSync(join(project, 'lyrics', 'song.lrc'), '[00:10.00]<00:10.00>drop <00:10.50>now\n')
  const host = {
    io: { read: async (p: string) => new Uint8Array(readFileSync(join(project, p))) },
  } as unknown as Host
  const cues = await loadTimedText(host, 'lyrics/song.lrc', { trim: 8 })
  assert.equal(cueAt(cues, 2.2)?.text, 'drop now')
  assert.equal(wordAt(cues, 2.6)?.text, 'now')
})
