// audio-listen, headless: copied into a project the way `add` lays it out, a recording made here
// with three known strokes, and Earshot's answer about it played by a stand-in (a saved answer, and
// a stub `earshot` module run with `python -m`), since Earshot is the person's own install. The
// trims are read back through a fake host.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'audio-listen')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'audio-listen', 'shaderera.item.json'), 'utf8'),
) as {
  files: string[]
}
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'audio-listen', f), join(project, f))
}
const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { clipAt, loadTrims } = (await from(
  'src/audio/trims.ts',
)) as typeof import('../audio-listen/src/audio/trims.ts')
const { peakOf, trimsOf } = (await from(
  'tools/listen.ts',
)) as typeof import('../audio-listen/tools/listen.ts')
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const python = spawnSync('python', ['--version']).status === 0

const RATE = 48000
const LENGTH = 3
/** Three strokes: where each starts, and how long it rises to its peak (a click, a tap, a swell). */
const STROKES = [
  { at: 0.2, rise: 0.003 },
  { at: 1.1, rise: 0.02 },
  { at: 2.0, rise: 0.3 },
]
const recording = () => {
  const pcm = new Float32Array(LENGTH * RATE)
  for (const s of STROKES)
    for (let i = Math.round(s.at * RATE); i < Math.round((s.at + s.rise + 0.25) * RATE); i++) {
      const t = i / RATE - s.at
      const env = t < s.rise ? t / s.rise : Math.exp(-(t - s.rise) / 0.04)
      pcm[i] = 0.6 * env * Math.sin(2 * Math.PI * 900 * t)
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
/** Earshot's find answer for the recording, in its shape: segments best first, 5 ms before each attack. */
const answer = (path: string) => ({
  summary: "Best moments for 'a short tap' in keys.wav: ...",
  path,
  query: 'a short tap',
  query_kind: 'event',
  duration: LENGTH,
  segments: [1, 0, 2].map((i, rank) => {
    const s = STROKES[i] as (typeof STROKES)[number]
    return {
      start: s.at - 0.005,
      end: s.at + s.rise + 0.25,
      duration: s.rise + 0.255,
      score: 3 - rank,
      z: 3 - rank,
      cosine: 0.3,
      verdict: rank < 2 ? 'strong' : 'plausible',
      kind: 'stroke',
      peak_dbfs: -4.4,
      head_db: -40,
      tail_db: -38,
      cut: rank === 2 ? 'tail cut' : '',
    }
  }),
})
const host = {
  io: { read: async (p: string) => new Uint8Array(readFileSync(join(project, p))) },
} as unknown as Host
const listen = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [join(project, 'tools', 'listen.ts'), ...args], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

test("audio-listen: a take's peak is the centre of its loudest 5 ms", () => {
  const pcm = recording()
  for (const s of STROKES) {
    const peak = peakOf(pcm, RATE, s.at - 0.005, s.at + s.rise + 0.25)
    assert.ok(Math.abs(peak - (s.at + s.rise)) <= 0.004, `${peak} vs ${s.at + s.rise}`)
  }
  assert.equal(peakOf(pcm, RATE, 1, 1.002), 1.001, 'shorter than the window: its middle')
  const trims = trimsOf(answer('keys.wav'), pcm, RATE)
  assert.deepEqual(
    trims.map((t) => [t.id, t.verdict, t.cut]),
    [
      ['take-1', 'strong', ''],
      ['take-2', 'strong', ''],
      ['take-3', 'plausible', 'tail cut'],
    ],
  )
  assert.throws(
    () => trimsOf({ error: 'cannot decode' }, pcm, RATE),
    /could not answer: cannot decode/,
  )
  assert.throws(() => trimsOf({ summary: 'x' }, pcm, RATE), /not an answer of Earshot's find/)
})

test('audio-listen: clipAt lands the peak on the hit point, and cuts the head before the film starts', () => {
  const trims = {
    source: { path: 'audio/whoosh.wav' },
  } as Parameters<typeof clipAt>[0]
  const whoosh = { start: 1, end: 2, peak: 1.3 } as Parameters<typeof clipAt>[1]
  assert.deepEqual(clipAt(trims, whoosh, 5), { src: 'audio/whoosh.wav', from: 1, to: 2, at: 4.7 })
  const early = clipAt(trims, whoosh, 0.1)
  assert.equal(early.at, 0)
  assert.ok(Math.abs(early.from - 1.2) < 1e-9, `the head goes: from ${early.from}`)
  assert.ok(Math.abs(early.at + (whoosh.peak - early.from) - 0.1) < 1e-9, 'the peak still lands')
})

test('audio-listen: a saved answer becomes trims stamped to the recording, refused once it changes', {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  mkdirSync(join(project, 'audio'), { recursive: true })
  writeFileSync(join(project, 'audio', 'keys.wav'), wav(recording()))
  writeFileSync(
    join(project, 'answer.json'),
    JSON.stringify(answer(join(project, 'audio', 'keys.wav'))),
  )
  const run = listen(['audio/keys.wav', '--answer', 'answer.json'])
  assert.equal(run.status, 0, run.stderr)
  const trims = await loadTrims(host, 'audio/keys.trims.json')
  assert.equal(trims.source.path, 'audio/keys.wav')
  assert.equal(trims.source.seconds, LENGTH)
  assert.equal(trims.params.query, 'a short tap')
  assert.equal(trims.tool.answer, 'answer.json')
  const peaks = [1, 0, 2].map((i) => (STROKES[i]?.at ?? 0) + (STROKES[i]?.rise ?? 0))
  for (const [i, t] of trims.trims.entries())
    assert.ok(
      Math.abs(t.peak - (peaks[i] ?? 0)) <= 0.004,
      `measured on the decoded file: ${t.peak}`,
    )
  // Another answer's file, or another description, is refused.
  writeFileSync(
    join(project, 'other.json'),
    JSON.stringify(answer(join(project, 'audio', 'other.wav'))),
  )
  assert.match(
    listen(['audio/keys.wav', '--answer', 'other.json']).stderr,
    /answer for .*other\.wav, not audio\/keys\.wav/,
  )
  assert.match(
    listen(['audio/keys.wav', 'a door slam', '--answer', 'answer.json']).stderr,
    /answers "a short tap", not "a door slam"/,
  )
  // The recording changes: the old trims would play the wrong moments.
  const changed = recording()
  changed[10] = 0.5
  writeFileSync(join(project, 'audio', 'keys.wav'), wav(changed))
  await assert.rejects(
    loadTrims(host, 'audio/keys.trims.json'),
    /other bytes than audio\/keys\.wav/,
  )
})

test('audio-listen: without an answer it runs Earshot with python -m, and says how to get it when that fails', {
  skip: (!ffmpeg || !python) && 'needs ffmpeg and python',
}, async () => {
  mkdirSync(join(project, 'audio'), { recursive: true })
  writeFileSync(join(project, 'audio', 'keys.wav'), wav(recording()))
  // A stand-in for Earshot: prints the answer, and the arguments it was given.
  const stub = join(project, 'stub', 'earshot')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, '__init__.py'), "__version__ = '0.2.0-stub'\n")
  writeFileSync(
    join(stub, '__main__.py'),
    [
      'import json, sys',
      `a = json.loads(${JSON.stringify(JSON.stringify(answer('audio/keys.wav')))})`,
      "a['argv'] = sys.argv[1:]",
      "open('argv.json', 'w').write(json.dumps(sys.argv[1:]))",
      'print(json.dumps(a))',
    ].join('\n'),
  )
  const run = listen(
    ['audio/keys.wav', 'a short tap', '--top', '3', '--kind', 'event', '--out', 'out/keys.json'],
    {
      PYTHONPATH: join(project, 'stub'),
    },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(project, 'argv.json'), 'utf8')), [
    'find',
    'audio/keys.wav',
    'a short tap',
    '--top',
    '3',
    '--kind',
    'event',
    '--json',
  ])
  const trims = await loadTrims(host, 'out/keys.json')
  assert.equal(trims.tool.earshot, '0.2.0-stub')
  assert.deepEqual(trims.params, { query: 'a short tap', top: 3, kind: 'event' })
  assert.equal(trims.trims.length, 3)
  // No Earshot where it was pointed: one message naming the three ways to give it.
  const none = listen(['audio/keys.wav', 'a short tap'], {
    EARSHOT_PYTHON: join(project, 'no-python'),
  })
  assert.equal(none.status, 2)
  assert.match(
    none.stderr,
    /Earshot did not run with .*no-python\. Install it .*--python or EARSHOT_PYTHON.*--answer/,
  )
})
