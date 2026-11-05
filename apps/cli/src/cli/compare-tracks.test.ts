import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { compareTracks, type FilmTracks, trackLines } from './compare-tracks.ts'

/** A smoothstep move from 0 to 100 over 0.5 s, starting at `start`. */
const move = (t: number, start: number) => {
  const p = Math.min(1, Math.max(0, (t - start) / 0.5))
  return 100 * p * p * (3 - 2 * p)
}
const FPS = 10
const late = 2 / FPS

/** A film of 2 s at 64×36 whose card moves 2 frames after the reference's, and its dot in step. */
const film = (): FilmTracks => ({
  width: 64,
  height: 36,
  duration: 2,
  fps: FPS,
  inspect: async (t) => ({
    objects: [
      { id: 'card', x: move(t, 0.6 + late) },
      { id: 'dot', x: move(t, 0.6) },
    ],
  }),
  elements: async (t) => [
    { id: 'card', box: [move(t, 0.6 + late), 0, 10, 10], opacity: 1 },
    { id: 'dot', box: [move(t, 0.6), 0, 4, 4], opacity: 1 },
  ],
})

const setup = (
  o: {
    frame?: { width: number; height: number }
    unit?: string
    times?: number[]
    kind?: string
  } = {},
) => {
  const root = tempDir('compare-tracks')
  writeFileSync(join(root, 'hero.mp4'), 'the reference')
  const sha256 = createHash('sha256').update('the reference').digest('hex')
  const times = o.times ?? Array.from({ length: 16 }, (_, i) => Number((0.2 + i / FPS).toFixed(6)))
  const scale = (o.frame?.width ?? 64) / 64
  const track = (element: string) => ({
    element,
    channel: 'x',
    unit: o.unit ?? 'source-px',
    samples: times.map((t) => [t, move(t, 0.6) * scale]),
  })
  const reference = join(root, 'tracks.json')
  writeFileSync(
    reference,
    JSON.stringify({
      format: 'shaderera.analysis/1',
      kind: o.kind ?? 'reference-tracks',
      source: { path: 'hero.mp4', bytes: 13, sha256 },
      tool: { script: 'tools/track.ts', version: '0.1.0' },
      params: { fps: FPS },
      frame: { width: o.frame?.width ?? 64, height: o.frame?.height ?? 36, pixelRatio: 1 },
      tracks: [track('#card'), track('#dot')],
      declared: [],
      limits: [],
      unknown: 'kept and ignored',
    }),
  )
  const pairs = (list: unknown) => {
    const file = join(root, 'pairs.json')
    writeFileSync(file, JSON.stringify(list))
    return file
  }
  return { root, reference, pairs }
}

for (const [how, card, dot] of [
  ['an inspect path', { path: 'objects[id=card].x' }, { path: 'objects[id=dot].x' }],
  ['a DOM element by data-id', { id: 'card', channel: 'x' }, { id: 'dot', channel: 'x' }],
] as const)
  test(`compare-tracks finds the element 2 frames late, and the other in step, by ${how} (#687)`, async () => {
    const { root, reference, pairs } = setup()
    const r = await compareTracks({
      reference,
      root,
      film: film(),
      pairs: pairs([
        { element: '#card', channel: 'x', film: card },
        { element: '#dot', channel: 'x', film: dot },
      ]),
      maxShift: 4,
    })
    const [c, d] = r.pairs as [(typeof r.pairs)[number], (typeof r.pairs)[number]]
    assert.equal(c.step, 0.1)
    // The film moves 2 steps later: read at --offset=-0.2 it is in step.
    assert.equal(c.offset.found?.steps, -2)
    assert.equal(c.offset.found?.seconds, -0.2)
    assert.equal(c.offset.scores.length, 9)
    assert.deepEqual(
      c.offset.scores.map((s) => s.shift),
      [-4, -3, -2, -1, 0, 1, 2, 3, 4],
    )
    assert.ok(c.difference && c.difference.max > 10)
    assert.equal(c.window.reference?.first, 0.7)
    assert.equal(c.window.film?.first, 0.9)
    assert.equal(d.offset.found?.steps, 0)
    assert.deepEqual(d.difference, { max: 0, mean: 0 })
    assert.equal(d.compared, 16)
    assert.equal(c.scaled, null)
    const lines = trackLines(r).join('\n')
    assert.match(lines, /#card x \(source-px\)/)
    assert.match(
      lines,
      /aligns best at -2 steps of 0\.1 s \(-0\.2 s, the film 2 steps later.*Aligned: --offset=-0\.2/,
    )

    // Read aligned, the card is in step too.
    const aligned = await compareTracks({
      reference,
      root,
      film: film(),
      pairs: pairs([{ element: '#card', channel: 'x', film: card }]),
      offset: -0.2,
      maxShift: 4,
    })
    assert.equal(aligned.pairs[0]?.offset.found?.steps, 0)
    assert.ok((aligned.pairs[0]?.difference?.max as number) < 1e-9)
  })

test('compare-tracks scales px units by the frames and says so; others as written (#687)', async () => {
  const { root, reference, pairs } = setup({ frame: { width: 128, height: 72 } })
  const r = await compareTracks({
    reference,
    root,
    film: film(),
    pairs: pairs([{ element: '#dot', channel: 'x', film: { path: 'objects[id=dot].x' } }]),
  })
  assert.deepEqual(r.pairs[0]?.scaled, { factor: 2, axis: 'x', from: [64, 36], to: [128, 72] })
  assert.deepEqual(r.pairs[0]?.difference, { max: 0, mean: 0 })
  // Without --max-shift: one second of steps.
  assert.equal(r.pairs[0]?.offset.maxShift, 10)

  const ratio = setup({ frame: { width: 128, height: 72 }, unit: 'ratio' })
  const as = await compareTracks({
    reference: ratio.reference,
    root: ratio.root,
    film: film(),
    pairs: ratio.pairs([{ element: '#dot', channel: 'x', film: { path: 'objects[id=dot].x' } }]),
  })
  assert.equal(as.pairs[0]?.scaled, null)
  assert.ok((as.pairs[0]?.difference?.max as number) > 0)
})

test('compare-tracks gives no offset, with why, for unevenly spaced samples (#687)', async () => {
  const { root, reference, pairs } = setup({ times: [0.2, 0.3, 0.45, 0.6, 0.9, 1.0] })
  const r = await compareTracks({
    reference,
    root,
    film: film(),
    pairs: pairs([{ element: '#dot', channel: 'x', film: { path: 'objects[id=dot].x' } }]),
    maxShift: 3,
  })
  assert.equal(r.pairs[0]?.step, null)
  assert.equal(r.pairs[0]?.offset.found, null)
  assert.equal(r.pairs[0]?.offset.why, "the reference's samples are not evenly spaced")
})

test('compare-tracks refuses a file or a pair, naming the reason (#687)', async () => {
  const run = (s: ReturnType<typeof setup>, list: unknown, extra: object = {}) =>
    compareTracks({
      reference: s.reference,
      root: s.root,
      film: film(),
      pairs: s.pairs(list),
      ...extra,
    })
  const ok = [{ element: '#dot', channel: 'x', film: { path: 'objects[id=dot].x' } }]

  await assert.rejects(
    run(setup({ kind: 'reference-style' }), ok),
    /is a "reference-style" analysis, not reference-tracks/,
  )
  const changed = setup()
  writeFileSync(join(changed.root, 'hero.mp4'), 'another reference')
  await assert.rejects(run(changed, ok), /was measured from other bytes than hero\.mp4/)

  const s = setup()
  await assert.rejects(
    run(s, [{ element: '#nope', channel: 'x', film: { path: 'objects[id=dot].x' } }]),
    /pair 0 \(#nope x\): .* has no element #nope: it has #card, #dot/,
  )
  await assert.rejects(
    run(s, [{ element: '#dot', channel: 'opacity', film: { path: 'objects[id=dot].x' } }]),
    /has no opacity for #dot: it has x/,
  )
  await assert.rejects(
    run(s, [{ element: '#dot', channel: 'x', film: { path: 'objects[id=nope].x' } }]),
    /nothing at objects\[id=nope\]\.x in inspect/,
  )
  await assert.rejects(
    run(s, [{ element: '#dot', channel: 'x', film: { id: 'nope', channel: 'x' } }]),
    /no element with data-id nope in the DOM/,
  )
  await assert.rejects(run(s, [{ element: '#dot', channel: 'x' }]), /pair 0 needs film/)
  // A pair with no sample in the film's time is refused, naming its samples' span.
  await assert.rejects(
    run(s, ok, { offset: -3 }),
    /pair 0 \(#dot x\): no sample in the film's time \(0 to 2 s\): its samples run 0\.2 to 1\.7 s, read at source time \+ 3 s/,
  )
})

test('compare-tracks leaves out samples with no film time, and says so, so its Aligned offset reads back (#727)', async () => {
  // A capture of the film's own length: 0 to 2 s, its end frame included.
  const times = Array.from({ length: 21 }, (_, i) => Number((i / FPS).toFixed(6)))
  const { root, reference, pairs } = setup({ times })
  const list = pairs([{ element: '#card', channel: 'x', film: { path: 'objects[id=card].x' } }])
  const r = await compareTracks({ reference, root, film: film(), pairs: list, maxShift: 4 })
  const p = r.pairs[0] as (typeof r.pairs)[number]
  assert.deepEqual(p.left, { count: 1, first: 2, last: 2 })
  assert.equal(p.compared, 20)
  assert.equal(p.samples.length, 20)
  assert.equal(p.offset.found?.seconds, -0.2)
  const lines = trackLines(r).join('\n')
  assert.match(lines, /left out: 1 sample with no film time \(0 to 2 s\), at source 2 s/)
  assert.match(lines, /Aligned: --offset=-0\.2/)

  // The printed offset, passed back: in step, the last three samples left out.
  const aligned = await compareTracks({
    reference,
    root,
    film: film(),
    pairs: list,
    offset: -0.2,
    maxShift: 4,
  })
  const a = aligned.pairs[0] as (typeof aligned.pairs)[number]
  assert.deepEqual(a.left, { count: 3, first: 1.8, last: 2 })
  assert.equal(a.offset.found?.steps, 0)
  assert.ok((a.difference?.max as number) < 1e-9)
  const text = trackLines(aligned).join('\n')
  assert.match(text, /measured at source time \+ 0\.2 s/)
  assert.match(text, /left out: 3 samples with no film time \(0 to 2 s\), at source 1\.8 to 2 s/)
})

test('compare-tracks reads a sample time written to 6 decimals on its film frame, so a jump on a frame reads 0 (#728)', async () => {
  // Holds: 0, 100 from frame 10, 50 from frame 40 (40 / 30 s, written 1.333333), at 30 fps.
  const opacity = (t: number) => (t >= 40 / 30 ? 50 : t >= 10 / 30 ? 100 : 0)
  const root = tempDir('compare-tracks')
  const reference = join(root, 'lottie.tracks.json')
  const times = Array.from({ length: 60 }, (_, k) => k / 30)
  writeFileSync(
    reference,
    JSON.stringify({
      format: 'shaderera.analysis/1',
      kind: 'reference-tracks',
      source: { url: 'https://example.com/' },
      frame: { width: 64, height: 36, pixelRatio: 1 },
      tracks: [
        {
          element: 'layers[0]',
          channel: 'o[0]',
          unit: 'ratio',
          samples: times.map((t) => [Number(t.toFixed(6)), opacity(t)]),
        },
      ],
    }),
  )
  const pairs = join(root, 'pairs.json')
  writeFileSync(
    pairs,
    JSON.stringify([
      { element: 'layers[0]', channel: 'o[0]', film: { path: 'objects[id=card].opacity' } },
    ]),
  )
  const r = await compareTracks({
    reference,
    pairs,
    root,
    film: {
      width: 64,
      height: 36,
      duration: 2,
      fps: 30,
      inspect: async (t) => ({ objects: [{ id: 'card', opacity: opacity(t) }] }),
    },
  })
  const p = r.pairs[0] as (typeof r.pairs)[number]
  assert.equal(p.samples[40]?.at, 1.333333)
  assert.equal(p.samples[40]?.film, 50)
  assert.deepEqual(p.difference, { max: 0, mean: 0 })
  assert.equal(p.offset.found?.steps, 0)
  assert.equal(p.offset.found?.seconds, 0)
})

test('apps/cli imports nothing from packages/plugins, and names no plugin it reads (#687)', () => {
  const src = fileURLToPath(new URL('..', import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(path)
      } else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && path !== fileURLToPath(import.meta.url)) {
        const text = readFileSync(path, 'utf8')
        if (/(?:from|import\s*\(|require\s*\()\s*['"][^'"]*packages\/plugins/.test(text))
          offenders.push(path)
        if (text.includes('analysis-reference-tracks')) offenders.push(path)
      }
    }
  }
  walk(src)
  assert.deepEqual(offenders, [])
})
