// audio-listen, headless: copied into a project the way `add` lays it out, a recording made here
// with three known strokes, heard through a stand-in for CLAP (the real model is a 780 MB download
// the tool makes on first use), and trims read back through a fake host.

import assert from 'node:assert/strict'
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
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'audio-listen', f), join(project, f))
}
const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { clipAt, loadTrims } = (await from(
  'src/audio/trims.ts',
)) as typeof import('../audio-listen/src/audio/trims.ts')
const { BACKGROUND, listen, peakOf, strokesOf, windowsOf } = (await from(
  'tools/listen.ts',
)) as typeof import('../audio-listen/tools/listen.ts')

const RATE = 48000
const LENGTH = 3
/** Three strokes: where each starts, how long it rises to its peak, and its pitch. */
const STROKES = [
  { at: 0.2, rise: 0.003, hz: 900 },
  { at: 1.1, rise: 0.02, hz: 900 },
  { at: 2.0, rise: 0.3, hz: 300 },
]
const recording = () => {
  const pcm = new Float32Array(LENGTH * RATE)
  for (const s of STROKES)
    for (let i = Math.round(s.at * RATE); i < Math.round((s.at + s.rise + 0.25) * RATE); i++) {
      const t = i / RATE - s.at
      const env = t < s.rise ? t / s.rise : Math.exp(-(t - s.rise) / 0.04)
      pcm[i] = 0.6 * env * Math.sin(2 * Math.PI * s.hz * t)
    }
  return pcm
}
const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within

test("audio-listen: a stroke per onset, and a take's peak is the centre of its loudest 5 ms", () => {
  const pcm = recording()
  const strokes = strokesOf(pcm, RATE)
  assert.equal(strokes.length, 3)
  for (const [i, s] of STROKES.entries()) {
    const k = strokes[i] as (typeof strokes)[number]
    assert.ok(near(k.start, s.at - 0.005, 0.006), `stroke ${i} starts ${k.start}`)
    assert.ok(k.end > s.at + s.rise && k.end <= s.at + s.rise + 0.3, `stroke ${i} ends ${k.end}`)
    const peak = peakOf(pcm, RATE, k.start, k.end)
    assert.ok(near(peak, s.at + s.rise, 0.004), `${peak} vs ${s.at + s.rise}`)
  }
  assert.equal(peakOf(pcm, RATE, 1, 1.002), 1.001, 'shorter than the window: its middle')
  // A noise that fades in over 20 ms is one stroke, not two.
  let seed = 3
  const noise = Float32Array.from({ length: RATE }, (_, i) => {
    seed = (seed * 16807) % 2147483647
    const t = i / RATE - 0.3
    return t < 0 || t > 0.4 ? 0 : 0.3 * Math.min(1, t / 0.02) * ((seed / 2147483647) * 2 - 1)
  })
  assert.equal(strokesOf(noise, RATE).length, 1)
  // Nor is a narrow noise that swells for 300 ms, wobbling as it rises (a whoosh).
  let y1 = 0
  let y2 = 0
  const swell = Float32Array.from({ length: RATE }, (_, i) => {
    seed = (seed * 16807) % 2147483647
    const t = i / RATE - 0.2
    const y = 0.02 * ((seed / 2147483647) * 2 - 1) + 1.96 * y1 - 0.98 * y2
    y2 = y1
    y1 = y
    return t < 0 || t > 0.6 ? 0 : 0.05 * Math.min(1, (t / 0.3) ** 2, (0.6 - t) / 0.1) * y
  })
  assert.equal(strokesOf(swell, RATE).length, 1)
  assert.deepEqual(
    windowsOf(3, 1).map((w) => w.start),
    [0, 0.5, 1, 1.5, 2],
  )
  assert.deepEqual(windowsOf(0, 1), [], 'nothing to cut, and no endless loop')
})

test('audio-listen: two hits 80 ms apart, the first still ringing, are both takes', async () => {
  // Each hit falls fast, then rings on 24 dB down: it has not decayed 35 dB when the next comes.
  const hit = (t: number) =>
    t < 0
      ? 0
      : (0.94 * Math.exp(-t / 0.02) + 0.06 * Math.exp(-t / 0.5)) * Math.sin(2 * Math.PI * 900 * t)
  const pcm = Float32Array.from(
    { length: RATE },
    (_, i) => 0.4 * (hit(i / RATE - 0.2) + hit(i / RATE - 0.28)),
  )
  const strokes = strokesOf(pcm, RATE)
  assert.equal(strokes.length, 2)
  const [a, b] = strokes as [(typeof strokes)[number], (typeof strokes)[number]]
  assert.ok(a.end <= b.start, `the first ends ${a.end}, before the second starts ${b.start}`)
  const heard = await listen(pcm, RATE, 'x', { top: 2, kind: 'event', win: 1, not: [] }, fake('x'))
  assert.equal(heard.trims.length, 2, 'the picker can take both')
})

/** A stand-in for CLAP: one axis per description; a 300 Hz take sounds like the query, a 900 Hz one like a mouse click. */
const fake = (query: string) => {
  let axes: string[] = []
  const axis = (name: string) => axes.map((a) => (a === name ? 1 : 0))
  return {
    async text(texts: readonly string[]) {
      axes = [...texts]
      return texts.map(axis)
    },
    async audio(clip: Float32Array) {
      let crossings = 0
      for (let i = 1; i < clip.length; i++)
        if ((clip[i - 1] ?? 0) < 0 && (clip[i] ?? 0) >= 0) crossings++
      const low = crossings / (clip.length / RATE) < 600
      const v = low ? axis(query) : axis('a mouse click')
      // Each take also fits the query a little, so their cosines differ.
      return v.map((x, i) => (i === 0 ? x + 0.1 : x))
    },
  }
}

test('audio-listen: takes come best first, each ranked against the other descriptions', async () => {
  const pcm = recording()
  const heard = await listen(
    pcm,
    RATE,
    'a low hum',
    { top: 2, kind: 'event', win: 2, not: ['a whistle'] },
    fake('a low hum'),
  )
  assert.equal(heard.candidates, 3)
  assert.deepEqual(
    heard.trims.map((t) => [t.id, t.kind, t.rank, t.heardAs]),
    [
      ['take-1', 'stroke', 1, 'a low hum'],
      ['take-2', 'stroke', 2, 'a mouse click'],
    ],
  )
  const [best] = heard.trims
  assert.ok(best && near(best.peak, 2.3, 0.004), `the low stroke's peak: ${best?.peak}`)
  assert.ok((best?.z ?? 0) > 0, `the query stands out: z ${best?.z}`)
  assert.ok(BACKGROUND.includes('a mouse click'))
  // Windows overlap; the picked ones never do. A silent recording has nothing to hear.
  const windows = await listen(
    pcm,
    RATE,
    'a low hum',
    { top: 5, kind: 'texture', win: 1, not: [] },
    fake('a low hum'),
  )
  for (const [i, a] of windows.trims.entries())
    for (const b of windows.trims.slice(i + 1))
      assert.ok(a.end <= b.start || a.start >= b.end, `${a.id} and ${b.id} overlap`)
  await assert.rejects(
    listen(
      new Float32Array(RATE),
      RATE,
      'x',
      { top: 1, kind: 'event', win: 1, not: [] },
      fake('x'),
    ),
    /no onsets: for a bed or an ambience use --kind texture/,
  )
  await assert.rejects(
    listen(
      new Float32Array(RATE),
      RATE,
      'x',
      { top: 1, kind: 'texture', win: 1, not: [] },
      fake('x'),
    ),
    /nothing in it is louder than -60 dBFS/,
  )
})

test('audio-listen: clipAt lands the peak on the hit point, and cuts the head before the film starts', () => {
  const trims = { source: { path: 'audio/whoosh.wav' } } as Parameters<typeof clipAt>[0]
  const whoosh = { start: 1, end: 2, peak: 1.3 } as Parameters<typeof clipAt>[1]
  assert.deepEqual(clipAt(trims, whoosh, 5), { src: 'audio/whoosh.wav', from: 1, to: 2, at: 4.7 })
  const early = clipAt(trims, whoosh, 0.1)
  assert.equal(early.at, 0)
  assert.ok(near(early.from, 1.2, 1e-9), `the head goes: from ${early.from}`)
  assert.ok(near(early.at + (whoosh.peak - early.from), 0.1, 1e-9), 'the peak still lands')
})

test('audio-listen: trims are refused once the recording changes, or when the file is not trims', async () => {
  const host = {
    io: { read: async (p: string) => new Uint8Array(readFileSync(join(project, p))) },
  } as unknown as Host
  const bytes = new Uint8Array([1, 2, 3])
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  mkdirSync(join(project, 'audio'), { recursive: true })
  writeFileSync(join(project, 'audio', 'keys.wav'), bytes)
  const doc = {
    format: 'shaderera.analysis/1',
    kind: 'sound-trims',
    source: { path: 'audio/keys.wav', bytes: 3, sha256: digest, seconds: 1 },
    tool: {},
    params: { query: 'a key press' },
    trims: [],
  }
  writeFileSync(join(project, 'audio', 'keys.trims.json'), JSON.stringify(doc))
  assert.equal((await loadTrims(host, 'audio/keys.trims.json')).params.query, 'a key press')
  writeFileSync(join(project, 'audio', 'keys.wav'), new Uint8Array([1, 2, 4]))
  await assert.rejects(
    loadTrims(host, 'audio/keys.trims.json'),
    /other bytes than audio\/keys\.wav/,
  )
  writeFileSync(join(project, 'audio', 'map.json'), JSON.stringify({ ...doc, kind: 'time-map' }))
  await assert.rejects(loadTrims(host, 'audio/map.json'), /not a shaderera.analysis\/1 sound-trims/)
})
