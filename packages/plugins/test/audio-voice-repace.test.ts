// audio-voice-repace, headless: copied into a project the way `add` lays it out (with
// text-timed-cues, which reads its words), a speech-like recording made here with known pauses,
// re-paced by the plugin's own tool, and its map read back through a fake host.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'audio-voice-repace')
rmSync(project, { recursive: true, force: true })
for (const item of ['text-timed-cues', 'audio-voice-repace']) {
  const label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
  }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, item, f), join(project, f))
  }
}
const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { loadTimeMap, pacedTime } = (await from(
  'src/audio/repace.ts',
)) as typeof import('../audio-voice-repace/src/audio/repace.ts')
const { cutsOf, repace } = (await from(
  'tools/voice-repace.ts',
)) as typeof import('../audio-voice-repace/tools/voice-repace.ts')
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const RATE = 48000
const LENGTH = 5.2
/** Five words; the pauses after them: 0.1 s (short), 1 s, 1 s (kept at 3.0), 0.6 s. */
const WORDS = [
  { start: 0.2, end: 0.6, text: 'every' },
  { start: 0.7, end: 1.1, text: 'long' },
  { start: 2.1, end: 2.5, text: 'pause' },
  { start: 3.5, end: 3.9, text: 'comes' },
  { start: 4.5, end: 4.9, text: 'out' },
]
const OPTIONS = { maxPause: 0.3, keep: [3], tempo: 1, fade: 0.01 }
/** At 0.3 s: the 1 s pause loses [1.25, 1.95], the kept one stays, the 0.6 s one loses [4.05, 4.35]. */
const KNOTS = [
  [0, 0],
  [1.25, 1.25],
  [1.95, 1.25],
  [4.05, 3.35],
  [4.35, 3.35],
  [5.2, 4.2],
]

/** A voice-like word: a buzz at 140 Hz with its harmonics, a syllable wobble, digital silence between. */
const voice = () => {
  const pcm = new Float32Array(Math.round(LENGTH * RATE))
  for (const w of WORDS)
    for (let i = Math.round(w.start * RATE); i < Math.round(w.end * RATE); i++) {
      const t = i / RATE - w.start
      const env =
        Math.min(1, t / 0.005, (w.end - w.start - t) / 0.02) *
        (0.7 + 0.3 * Math.sin(2 * Math.PI * 5 * t))
      pcm[i] =
        0.4 *
        env *
        (Math.sin(2 * Math.PI * 140 * t + 1) + 0.5 * Math.sin(2 * Math.PI * 420 * t + 1))
    }
  return pcm
}
const wav = (pcm: Float32Array) => {
  const v = new DataView(new ArrayBuffer(44 + pcm.length * 2))
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  text(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true)
  v.setUint32(28, RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++)
    v.setInt16(44 + i * 2, Math.round((pcm[i] ?? 0) * 32767), true)
  return new Uint8Array(v.buffer)
}
/** Where sound starts after at least 50 ms of silence, in seconds. */
const onsets = (pcm: Float32Array) => {
  const found: number[] = []
  let quiet = Number.POSITIVE_INFINITY
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i] ?? 0) < 0.01) quiet++
    else {
      if (quiet >= 0.05 * RATE) found.push(i / RATE)
      quiet = 0
    }
  }
  return found
}
const near = (a: readonly number[], b: readonly number[], within: number) =>
  a.length === b.length && a.every((x, i) => Math.abs(x - (b[i] ?? Number.NaN)) <= within)

test('audio-voice-repace: long unkept pauses lose their middle, and the map says where each word went', () => {
  assert.deepEqual(
    cutsOf(WORDS, OPTIONS).map((c) => c.map((x) => Math.round(x * 1e6) / 1e6)),
    [
      [1.25, 1.95],
      [4.05, 4.35],
    ],
  )
  const paced = repace(voice(), 1, RATE, WORDS, OPTIONS)
  assert.deepEqual(paced.knots, KNOTS)
  assert.equal(paced.cuts, 2)
  assert.equal(paced.pcm.length, Math.round(4.2 * RATE))
  const map = { knots: paced.knots } as Parameters<typeof pacedTime>[0]
  const moved = WORDS.map((w) => pacedTime(map, w.start))
  assert.ok(near(onsets(paced.pcm), moved, 0.002), `${onsets(paced.pcm)} vs ${moved}`)
  assert.equal(pacedTime(map, 1.6), 1.25, 'inside a removed stretch: the join')
  assert.equal(pacedTime(map, 6.2), 5.2, 'after the end: its own length')
  // A slower tempo stretches every new time; the cuts are the same.
  const slow = repace(voice(), 1, RATE, WORDS, { ...OPTIONS, tempo: 0.8 })
  assert.deepEqual(
    slow.knots,
    KNOTS.map(([x, y]) => [x, Math.round(((y as number) / 0.8) * 1e6) / 1e6]),
  )
  assert.throws(
    () => repace(voice(), 1, RATE, WORDS, { ...OPTIONS, fade: 0.3 }),
    /--fade 0.3 must be/,
  )
})

test('audio-voice-repace: the tool writes the paced audio and a map that refuses a changed recording', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  mkdirSync(join(project, 'audio'), { recursive: true })
  mkdirSync(join(project, 'words'), { recursive: true })
  writeFileSync(join(project, 'audio', 'voice.wav'), wav(voice()))
  // A speech-to-text transcript, as Paxa Labs STT writes it: read through text-timed-cues.
  writeFileSync(
    join(project, 'words', 'voice.json'),
    JSON.stringify({ text: 'every long pause comes out', words: WORDS }),
  )
  const tool = join(project, 'tools', 'voice-repace.ts')
  const run = spawnSync(
    process.execPath,
    [tool, 'audio/voice.wav', 'words/voice.json', '--out', 'audio/voice-paced.wav', '--keep', '3'],
    { cwd: project, encoding: 'utf8' },
  )
  assert.equal(run.status, 0, run.stderr)
  const files = new Map<string, Uint8Array>()
  const host = {
    io: {
      read: async (p: string) => files.get(p) ?? new Uint8Array(readFileSync(join(project, p))),
    },
  } as unknown as Host
  const map = await loadTimeMap(host, 'audio/voice-paced.map.json')
  assert.equal(map.kind, 'time-map')
  assert.equal(map.source.path, 'audio/voice.wav')
  assert.equal(map.output.path, 'audio/voice-paced.wav')
  assert.deepEqual(map.knots, KNOTS)
  assert.ok(Math.abs(map.output.seconds - 4.2) < 0.001)
  const raw = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    join(project, 'audio', 'voice-paced.wav'),
    '-f',
    'f32le',
    '-ac',
    '1',
    'pipe:1',
  ])
  const out = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const moved = WORDS.map((w) => pacedTime(map, w.start))
  assert.ok(near(onsets(out), moved, 0.002), `${onsets(out)} vs ${moved}`)

  const source = new Uint8Array(readFileSync(join(project, 'audio', 'voice.wav')))
  files.set('audio/voice.wav', new Uint8Array([...source, 0]))
  await assert.rejects(
    loadTimeMap(host, 'audio/voice-paced.map.json'),
    /was made from other bytes than audio\/voice\.wav/,
  )
  files.set(
    'audio/voice-paced.map.json',
    new TextEncoder().encode(JSON.stringify({ format: 'shaderera.analysis/1', kind: 'regions' })),
  )
  await assert.rejects(
    loadTimeMap(host, 'audio/voice-paced.map.json'),
    /not a shaderera\.analysis\/1 time-map/,
  )
})
