// analysis-reference-tracks, headless: copied into a project the way `add` lays it out, an
// artifact written by the plugin's own writer from a file source and from a page source, and read
// back through a fake host; then a changed source, another format or kind and malformed tracks are
// each refused, and values are read before, at, between and after the samples.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'analysis-reference-tracks')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'analysis-reference-tracks', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'analysis-reference-tracks', f), join(project, f))
}
const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { at, loadTracks, track } = (await from(
  'src/reference/tracks.ts',
)) as typeof import('../analysis-reference-tracks/src/reference/tracks.ts')
const { fileSource, round, tracksJson } = (await from(
  'tools/reference-tracks.ts',
)) as typeof import('../analysis-reference-tracks/tools/reference-tracks.ts')
type TracksDoc = import('../analysis-reference-tracks/tools/reference-tracks.ts').TracksDoc

const clip = new TextEncoder().encode('a stand-in for the reference clip')
const enc = (s: string) => new TextEncoder().encode(s)
const hostOf = (files: Map<string, Uint8Array>) =>
  ({
    io: {
      read: async (p: string) => {
        const bytes = files.get(p)
        if (!bytes) throw new Error(`No file ${p}`)
        return bytes
      },
    },
  }) as unknown as Host

/** A card that moves right from 0.5 s, and fades in; times as an analyser took them, unrounded. */
const doc = async (): Promise<TracksDoc> => ({
  format: 'shaderera.analysis/1',
  kind: 'reference-tracks',
  source: await fileSource('references/card.mp4', clip),
  tool: { script: 'test', version: '0.1.0' },
  params: { fps: 30, trigger: 'none' },
  frame: { width: 1280, height: 720, pixelRatio: 1 },
  tracks: [
    {
      element: 'card',
      channel: 'x',
      unit: 'source-px',
      samples: [
        [0.5, 100],
        [0.5 + 1 / 30, 112.000049],
        [0.5 + 2 / 30, 130],
        [1, 160],
      ],
    },
    {
      element: 'card',
      channel: 'opacity',
      unit: 'ratio',
      samples: [
        [0.5, 0],
        [1, 1],
        [1.5, null],
      ],
    },
  ],
  declared: [{ element: 'card', type: 'note', easing: 'cubic-bezier(.16,1,.3,1)', z: 1, a: 2 }],
  limits: [{ where: 'card', reason: 'motion blur hides the edge', from: 0.5, to: 0.6 }],
})

const written = tracksJson(await doc())
const files = new Map([
  ['references/card.mp4', clip],
  ['references/card.tracks.json', enc(written)],
])

test('analysis-reference-tracks: the writer rounds, orders and gives the same bytes every time', async () => {
  const shuffled = await doc()
  shuffled.tracks.reverse()
  shuffled.params = { trigger: 'none', fps: 30 }
  assert.equal(tracksJson(shuffled), written)
  const parsed = JSON.parse(written)
  assert.deepEqual(Object.keys(parsed), [
    'format',
    'kind',
    'source',
    'tool',
    'params',
    'frame',
    'tracks',
    'declared',
    'limits',
  ])
  assert.deepEqual(Object.keys(parsed.source), ['path', 'bytes', 'sha256'])
  assert.deepEqual(
    parsed.tracks.map((q: { channel: string }) => q.channel),
    ['opacity', 'x'],
  )
  // Time to a microsecond, values to 1/10000; declared kept as written, its keys sorted.
  assert.deepEqual(parsed.tracks[1].samples, [
    [0.5, 100],
    [0.533333, 112],
    [0.566667, 130],
    [1, 160],
  ])
  assert.deepEqual(Object.keys(parsed.declared[0]), ['a', 'easing', 'element', 'type', 'z'])
  assert.equal(parsed.declared[0].easing, 'cubic-bezier(.16,1,.3,1)')
  assert.ok(written.endsWith('}\n'))
  assert.match(written, /\n {4}\{"element":"card","channel":"x","unit":"source-px","samples":/)
  assert.equal(round(-0.00004, 4), 0)
  assert.equal(round(2.00005, 4), 2.0001)
  assert.equal(round(-2.00005, 4), -2.0001)
})

test('analysis-reference-tracks: loads a file source and reads one channel', async () => {
  const r = await loadTracks(hostOf(files), 'references/card.tracks.json')
  assert.equal(r.kind, 'reference-tracks')
  assert.equal(r.path, 'references/card.tracks.json')
  assert.deepEqual(r.frame, { width: 1280, height: 720, pixelRatio: 1 })
  assert.equal(track(r, 'card', 'x').unit, 'source-px')
  assert.equal(r.limits[0]?.reason, 'motion blur hides the edge')
  assert.throws(() => track(r, 'card', 'rotate'), /has no rotate for card: it has opacity, x/)
  assert.throws(() => track(r, 'title', 'x'), /has no element title: it has card/)
})

test('analysis-reference-tracks: refuses a changed source, another format or kind, and bad tracks', async () => {
  const host = (json: string, clipBytes = clip) =>
    hostOf(
      new Map([
        ['references/card.mp4', clipBytes],
        ['t.json', enc(json)],
      ]),
    )
  await assert.rejects(
    loadTracks(host(written, enc('another clip')), 't.json'),
    /t\.json was measured from other bytes than references\/card\.mp4; run its analyser again/,
  )
  const parsed = JSON.parse(written)
  await assert.rejects(
    loadTracks(host(JSON.stringify({ ...parsed, format: 'shaderera.analysis/0' })), 't.json'),
    /not shaderera\.analysis\/1; rebuild it/,
  )
  await assert.rejects(
    loadTracks(host(JSON.stringify({ ...parsed, kind: 'regions' })), 't.json'),
    /is a "regions" analysis, not reference-tracks/,
  )
  await assert.rejects(
    loadTracks(host(JSON.stringify({ ...parsed, kind: 'reference-style' })), 't.json'),
    /read it with loadStyle, from analysis-web-capture/,
  )
  await assert.rejects(loadTracks(host('{"format":'), 't.json'), /t\.json is not JSON/)
  const withSamples = (samples: unknown) =>
    JSON.stringify({ ...parsed, tracks: [{ ...parsed.tracks[0], samples }] })
  await assert.rejects(
    loadTracks(
      host(
        withSamples([
          [1, 0],
          [1, 2],
        ]),
      ),
      't.json',
    ),
    /track 0 \(card opacity\): sample 1 at 1 s is not after the one before/,
  )
  await assert.rejects(loadTracks(host(withSamples([[0, 'a']])), 't.json'), /not a finite number/)
  await assert.rejects(loadTracks(host(withSamples([])), 't.json'), /has no samples/)
  await assert.rejects(
    loadTracks(
      host(JSON.stringify({ ...parsed, tracks: [parsed.tracks[0], parsed.tracks[0]] })),
      't.json',
    ),
    /track 1 \(card opacity\) is there twice/,
  )
  const d = await doc()
  assert.throws(() => tracksJson({ ...d, colour: 1 } as TracksDoc), /has no field colour/)
  const close = await doc()
  ;(close.tracks[0] as { samples: [number, number][] }).samples = [
    [0.1, 0],
    [0.1000001, 1],
  ]
  assert.throws(() => tracksJson(close), /card x: samples 0 and 1 round to one time/)
  const huge = await doc()
  ;(huge.tracks[0] as { samples: [number, number][] }).samples = [[0, 1e305]]
  assert.throws(() => tracksJson(huge), /card x: sample 0: 1e\+305 is too large to round/)
  const refused = (change: Partial<TracksDoc>, message: RegExp) =>
    assert.throws(() => tracksJson({ ...d, ...change } as TracksDoc), message)
  refused(
    { declared: [{ element: 'card' } as never] },
    /declared 0 needs to name its element and its type/,
  )
  refused(
    { limits: [{ where: 'card', reason: 'r', from: 'x' } as never] },
    /limit 0 \(card\): from and to are source seconds/,
  )
  refused(
    { limits: [{ where: 'card', reason: 'r', from: 0.6, to: 0.5 }] },
    /limit 0 \(card\): from 0\.6 s is after to 0\.5 s/,
  )
  refused({ limits: [{ where: 'card' } as never] }, /limit 0 needs a where and a reason/)
  refused(
    { source: { ...d.source, bytes: -3.5 } as never },
    /source file needs a path, its bytes \(a whole number\)/,
  )
})

test('analysis-reference-tracks: a field a later analyser adds to a track is kept, after the fixed ones', async () => {
  const d = await doc()
  Object.assign(d.tracks[0] as object, { precision: 6, confidence: [0.9, 0.8, 0.7, 0.6] })
  const json = tracksJson(d)
  const x = JSON.parse(json).tracks[1]
  assert.deepEqual(Object.keys(x), [
    'element',
    'channel',
    'unit',
    'samples',
    'confidence',
    'precision',
  ])
  assert.deepEqual(x.confidence, [0.9, 0.8, 0.7, 0.6])
  assert.equal(x.precision, 6)
  const r = await loadTracks(
    hostOf(
      new Map([
        ['references/card.mp4', clip],
        ['t.json', enc(json)],
      ]),
    ),
    't.json',
  )
  assert.equal(track(r, 'card', 'x').precision, 6)
})

test('analysis-reference-tracks: a page source needs no file, and its responses are sorted', async () => {
  const d = await doc()
  const h = 'b'.repeat(64)
  const page = {
    ...d,
    source: {
      url: 'https://example.com/hero',
      date: '2026-11-04T08:00:00.000Z',
      viewport: { height: 720, width: 1280 },
      devicePixelRatio: 2,
      responses: [
        { url: 'https://example.com/b.js', status: 200, sha256: h },
        { sha256: 'a'.repeat(64), url: 'https://example.com/a.css', status: 200 },
      ],
    },
  }
  const json = tracksJson(page)
  const parsed = JSON.parse(json)
  assert.deepEqual(Object.keys(parsed.source), [
    'url',
    'date',
    'viewport',
    'devicePixelRatio',
    'responses',
  ])
  assert.deepEqual(Object.keys(parsed.source.viewport), ['width', 'height'])
  assert.deepEqual(
    parsed.source.responses.map((r: { url: string }) => r.url),
    ['https://example.com/a.css', 'https://example.com/b.js'],
  )
  assert.deepEqual(Object.keys(parsed.source.responses[0]), ['url', 'status', 'sha256'])
  const r = await loadTracks(hostOf(new Map([['p.json', enc(json)]])), 'p.json')
  assert.equal(r.source.devicePixelRatio === 2, true)
  assert.throws(
    () => tracksJson({ ...page, source: { ...page.source, responses: [{ url: 'x' }] } } as never),
    /source response 0 needs a url, a status and a sha256/,
  )
  const bad = (source: object, message: RegExp) =>
    assert.throws(
      () => tracksJson({ ...page, source: { ...page.source, ...source } } as never),
      message,
    )
  bad({ date: 'yesterday' }, /source page date is "yesterday", not ISO 8601 in UTC/)
  bad({ date: '2026-11-04T08:00:00+07:00' }, /not ISO 8601 in UTC/)
  bad(
    { responses: [{ url: 'x', status: 200.5, sha256: h }] },
    /source response 0 needs a url, a status/,
  )
})

test('analysis-reference-tracks: null before the first sample, the sample at its time, the last held after', async () => {
  const r = await loadTracks(hostOf(files), 'references/card.tracks.json')
  const x = track(r, 'card', 'x')
  for (const between of ['hold', 'linear'] as const) {
    assert.equal(at(x, 0, { between }), null)
    assert.equal(at(x, 0.499999, { between }), null)
    assert.equal(at(x, 0.5, { between }), 100)
    assert.equal(at(x, 0.533333, { between }), 112)
    assert.equal(at(x, 1, { between }), 160)
    assert.equal(at(x, 1.000001, { between }), 160)
    assert.equal(at(x, 60, { between }), 160)
  }
})

test('analysis-reference-tracks: hold keeps the earlier sample, linear draws a line to the next', async () => {
  const r = await loadTracks(hostOf(files), 'references/card.tracks.json')
  const x = track(r, 'card', 'x')
  assert.equal(at(x, 0.52, { between: 'hold' }), 100)
  assert.equal(at(x, 0.8, { between: 'hold' }), 130)
  // Halfway from 0.566667 (130) to 1 (160).
  const mid = (0.566667 + 1) / 2
  assert.ok(Math.abs((at(x, mid, { between: 'linear' }) as number) - 145) < 1e-9)
  assert.ok(Math.abs((at(x, 0.5 + 0.0333333 / 2, { between: 'linear' }) as number) - 106) < 1e-3)
  // Next to a null sample, linear holds the earlier value; at and after the null, null.
  const o = track(r, 'card', 'opacity')
  assert.equal(at(o, 0.75, { between: 'linear' }), 0.5)
  assert.equal(at(o, 1.25, { between: 'linear' }), 1)
  assert.equal(at(o, 1.5, { between: 'linear' }), null)
  assert.equal(at(o, 9, { between: 'hold' }), null)
  // `between` is required, and the time must be a number.
  assert.throws(() => at(x, 0.6, {} as never), /needs between: 'hold' or 'linear'/)
  assert.throws(() => at(x, Number.NaN, { between: 'hold' }), /needs a finite source time/)
})
