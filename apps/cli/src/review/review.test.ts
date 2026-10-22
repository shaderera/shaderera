import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCanvas } from '@napi-rs/canvas'
import { toSrt, windowCaptions } from '@shaderera/core/host'
import { tempDir } from '../fixtures/temp.ts'
import { boxFrame, memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import type { Requirements } from '../project/requirements.ts'
import { shotsOf } from './measure.ts'
import { pngWriter, readingShort, review, reviewTimes, toPng } from './review.ts'

/** fixtures/mcp's film in memory: a red box that the camera slides left, inspected and pickable. */
const film = () => {
  const project = memoryProject()
  const child = memoryChild({
    size: { width: 64, height: 36 },
    frame: boxFrame(64, 36),
    inspect: (t) => ({ camera: { id: 'camera', x: t * 10 }, box: { id: 'box', x: 20 - 10 * t } }),
    pick: (t, x, y) =>
      x >= 20 - 10 * t && x < 28 - 10 * t && y >= 10 && y < 18 ? { id: 'box' } : null,
    camera: (t) => ({
      view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t * 10, 0, -5, 1],
      projection: [0.5625, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.001, -1, 0, 0, -0.1001, 0],
    }),
  })
  return { project, child }
}

test('review (quick) on a film without shots or text: measured or unknown, never a fake pass', async () => {
  const { project, child } = film()
  const outDir = tempDir('review')
  try {
    const r = await review({ project, child, outDir, quick: true })
    assert.equal(r.version, 1)
    assert.deepEqual(r.manifest, { width: 64, height: 36, fps: 10, duration: 1 })
    // No shots: 7 evenly spaced frames and the last (here the 7th, at 0.9 s, is the last).
    assert.equal(r.frames.length, 7)
    assert.equal(r.frames.at(-1)?.t, 0.9)
    for (const f of r.frames) assert.ok(existsSync(f.file) && existsSync(f.thumb))
    assert.ok(existsSync(r.contactSheet))
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]))
    for (const id of [
      'determinism',
      'readback',
      'text-fit',
      'text-overlap',
      'glyphs',
      'copy',
      'format',
    ])
      assert.equal(by[id]?.status, 'unknown', id)
    // The box moves to the last frame: no end hold, measured but not judged, since nothing asks for
    // one (decision 0011); the same for blank frames.
    assert.equal(by['end-hold']?.status, 'info')
    assert.match(by['end-hold']?.measured ?? '', /held at the end: pixels still/)
    assert.equal(by['blank-frames']?.status, 'info')
    // No captions(): measured as info, with no subtitle sidecar to judge.
    assert.equal(by.captions?.status, 'info')
    assert.equal(r.diagnostics.captions, null)
    assert.equal(by.alpha?.status, 'unknown')
    for (const c of r.checks) if (c.status === 'pass') assert.ok(c.measured, c.id)
    assert.ok(r.diagnostics.alpha.nonOpaque > 0.9)
    // No audio(): no audio diagnostics, in every host (node/contract.it.ts).
    assert.equal(r.diagnostics.audio, null)
  } finally {
    await child.close()
  }
})

test('review removes frames from an earlier run in its out dir, and nothing else', async () => {
  const { project, child } = film()
  const outDir = tempDir('review')
  const stale = ['07-0.95s.png', '07-0.95s.thumb.png']
  for (const f of [...stale, 'notes.txt']) writeFileSync(join(outDir, f), '')
  try {
    const r = await review({ project, child, outDir, quick: true })
    const left = readdirSync(outDir).sort()
    for (const f of stale) assert.ok(!left.includes(f), f)
    assert.ok(left.includes('notes.txt'))
    assert.equal(left.length, r.frames.length * 2 + 2)
  } finally {
    await child.close()
  }
})

test('review takes shot spans from inspect: each shot where it is alone, the transition in the overlap', async () => {
  const project = memoryProject()
  // Shots as motion-shot-list places them: a 0.2 s dissolve from 0.4 to 0.6 s, extra fields kept.
  const shots = [
    { id: 'open', index: 0, dur: 0.6, transition: 0, start: 0, end: 0.6 },
    { id: 'close', index: 1, dur: 0.6, transition: 0.2, start: 0.4, end: 1 },
  ]
  const child = memoryChild({
    size: { width: 64, height: 36 },
    frame: boxFrame(64, 36),
    inspect: () => ({ shots }),
  })
  const outDir = tempDir('review')
  try {
    const r = await review({ project, child, outDir, quick: true })
    assert.deepEqual(
      r.frames.map((f) => [f.label, f.t]),
      [
        ['open', 0.2],
        ['transition', 0.5],
        ['close', 0.8],
        ['last frame', 0.9],
      ],
    )
  } finally {
    await child.close()
  }
})

test('review frames: moments keep the midpoint transition; spans at a hard cut have none', () => {
  assert.deepEqual(
    reviewTimes(
      [
        { id: 'a', at: 1 },
        { id: 'b', at: 3 },
      ],
      10,
      4,
    ).map((f) => [f.label, f.t]),
    [
      ['a', 1],
      ['transition', 2],
      ['b', 3],
      ['last frame', 3.9],
    ],
  )
  const cut = shotsOf({
    shots: [
      { id: 'b', start: 2, end: 4 },
      { id: 'a', start: 0, end: 2 },
    ],
  })
  assert.deepEqual(
    reviewTimes(cut, 10, 4).map((f) => [f.label, f.t]),
    [
      ['a', 1],
      ['b', 3],
      ['last frame', 3.9],
    ],
  )
})

test('reading time: the longest visible stretch of each text against a declared max(min, characters / rate)', () => {
  const at = (id: string, text: string, ts: number[], opacity = 1) =>
    ts.map((t) => ({ id, text, box: [0, 0, 1, 1] as [number, number, number, number], opacity, t }))
  const sampleT = Array.from({ length: 41 }, (_, i) => i * 0.25)
  const runs = [
    // 1.0 s visible: enough for a short line.
    ...at('title', 'Open', [1, 1.25, 1.5, 1.75]),
    // 28 Thai graphemes need 1.87 s; shown 1.5 s.
    ...at('body', 'ส่งตรงจากสวนถึงบ้านคุณภายในหนึ่งวัน', [3, 3.25, 3.5, 3.75, 4, 4.25]),
    // Faint (opacity 0.3): not readable, so not counted as shown.
    ...at('ghost', 'Hello', [6, 6.25, 6.5, 6.75], 0.3),
    // Two stretches of 0.5 s are not one 1 s stretch.
    ...at('blink', 'Go', [8, 8.25, 9, 9.25]),
  ]
  const short = readingShort(runs, sampleT, { min: 0.8, charsPerSecond: 15 })
  assert.deepEqual(
    short.map((s) => [s.id, s.shown, s.need]),
    [
      ['body', 1.5, 1.87],
      ['blink', 0.5, 0.8],
    ],
  )
})

test("the last frame reviewed is the export's last frame, also when duration × fps is not whole", () => {
  // 10.01 s at 30 fps exports frames 0 to 300: t = 10 is a frame.
  assert.equal(reviewTimes([], 30, 10.01).at(-1)?.t, 10)
})

test('reading time at 30 fps: samples snapped to frames still make one stretch', () => {
  // review samples every 0.25 s snapped to frames: at 30 fps they are 0.2333 s or 0.2667 s apart.
  const sampleT = [...new Set(Array.from({ length: 25 }, (_, i) => Math.round(i * 7.5) / 30))]
  const shown = sampleT.filter((t) => t >= 1 && t <= 3.6)
  const runs = shown.map((t) => ({
    id: 'title',
    text: 'NORTHWIND',
    box: [0, 0, 1, 1] as [number, number, number, number],
    t,
  }))
  assert.deepEqual(readingShort(runs, sampleT, { min: 1.5, charsPerSecond: 15 }), [])
})

test('toPng encodes off the main thread to the bytes the synchronous encode made, full and scaled', async () => {
  const width = 64
  const height = 36
  const px = boxFrame(width, height)(0.5).pixels
  // The encode toPng replaced: toBuffer on the main thread.
  const before = (max: number) => {
    const ctx = createCanvas(width, height).getContext('2d')
    const image = ctx.createImageData(width, height)
    image.data.set(px)
    ctx.putImageData(image, 0, 0)
    if (max >= width) return ctx.canvas.toBuffer('image/png')
    const small = createCanvas(max, Math.round((height * max) / width)).getContext('2d')
    small.drawImage(ctx.canvas, 0, 0, small.canvas.width, small.canvas.height)
    return small.canvas.toBuffer('image/png')
  }
  assert.deepEqual(await toPng(px, width, height), before(Infinity))
  assert.deepEqual(await toPng(px, width, height, 32), before(32))
})

test("review writes a frame that fits the thumb as its own thumb, and pngWriter throws an encode's error", async () => {
  const { project, child } = film()
  const outDir = tempDir('review')
  try {
    const r = await review({ project, child, outDir, quick: true })
    for (const f of r.frames) assert.deepEqual(readFileSync(f.thumb), readFileSync(f.file))
  } finally {
    await child.close()
  }
  const pngs = pngWriter()
  await pngs.write(join(outDir, 'x.png'), Promise.reject(new Error('no encode')))
  await assert.rejects(pngs.done(), /no encode/)
})

test('captions: measured as info; a declared maxCps fails exactly the caption over it', async () => {
  const captions = [
    { start: 0, end: 0.5, text: 'Hi' },
    { start: 0.5, end: 0.9, text: 'ส่งตรงจากสวน' },
    { start: 6.6, end: 9.6, text: 'This third caption runs far too long to read' },
  ]
  const project = memoryProject()
  const child = memoryChild({ size: { width: 64, height: 36 }, captions })
  const outDir = tempDir('review')
  try {
    const run = async (requirements?: Requirements) =>
      (await review({ project, child, outDir, quick: true, requirements })).checks.find(
        (c) => c.id === 'captions',
      )
    const info = await run()
    assert.equal(info?.status, 'info')
    assert.match(
      info?.measured ?? '',
      /^3 captions: at most 27.5 cps, 1 lines, 44 characters a line/,
    )
    // 11 grapheme clusters in 0.4 s: 27.5 cps; "Hi" is 4 cps.
    const judged = await run({ version: 1, captions: { maxCps: 20 } })
    assert.equal(judged?.status, 'fail')
    assert.match(judged?.detail ?? '', /^#2 "ส่งตรงจากสวน" at 0.5 s: 27.5 cps > 20$/)
    assert.deepEqual(judged?.at, [0.5])
    // Numbered from 1 as in the SRT; the quote ends on a whole word.
    const third = await run({ version: 1, captions: { maxCps: 10 } })
    assert.match(
      third?.detail ?? '',
      /; #3 "This third caption runs far…" at 6.6 s: 14.667 cps > 10$/,
    )
    const open = memoryChild({
      size: { width: 64, height: 36 },
      captions: [{ start: 0, end: Number.POSITIVE_INFINITY, text: 'last line' }],
    })
    try {
      const r = await review({ project, child: open, outDir, quick: true })
      const c = r.checks.find((x) => x.id === 'captions')
      assert.equal(c?.status, 'fail')
      assert.match(c?.detail ?? '', /no end \(end: Infinity.*which every export refuses/)
      assert.equal(r.diagnostics.captions?.[0]?.end, null)
    } finally {
      await open.close()
    }
  } finally {
    await child.close()
  }
})

test('captions: review, render and the SRT number an out-of-order list with a blank the same way', async () => {
  const captions = [
    { start: 2, end: 3, text: 'Second' },
    { start: 1, end: 1.5, text: '  ' },
    { start: 0, end: 1, text: 'First' },
  ]
  const srt = toSrt(windowCaptions(captions, 0, 10))
  assert.match(srt, /^1\n.*\nFirst\n\n2\n.*\nSecond\n$/)
  const bad = [...captions, { start: 4, end: Number.POSITIVE_INFINITY, text: 'Last' }]
  assert.throws(() => windowCaptions(bad, 0, 10), /^Error: Item 4 of captions\(\) needs/)
  const project = memoryProject()
  const child = memoryChild({ size: { width: 64, height: 36 }, captions: bad })
  const outDir = tempDir('review')
  try {
    const r = await review({
      project,
      child,
      outDir,
      quick: true,
      requirements: { version: 1, captions: { maxCps: 1, minDuration: 2 } },
    })
    const detail = r.checks.find((c) => c.id === 'captions')?.detail ?? ''
    // The blank is not in the SRT and is not judged; the refused caption is named as render names it.
    assert.match(detail, /^item 4 of captions\(\) "Last" at 4 s: no end/)
    assert.match(detail, /; #1 "First" at 0 s: 5 cps > 1, 1 s < 2 s; #2 "Second" at 2 s: /)
    assert.doesNotMatch(detail, /item 2/)
    assert.deepEqual(
      r.diagnostics.captions?.map((c) => [c.index, c.item]),
      [
        [1, 3],
        [null, 2],
        [2, 1],
        [null, 4],
      ],
    )
  } finally {
    await child.close()
  }
})
