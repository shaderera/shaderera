import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCanvas } from '@napi-rs/canvas'
import type { Json } from '@shaderera/core'
import { tempDir } from '../fixtures/temp.ts'
import { boxFrame, memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import {
  pngWriter,
  previewTimes,
  readingShort,
  review,
  reviewTimes,
  sheetFrames,
  toPng,
} from './review.ts'

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

test('review renders every 0.25 s sample up to 30 s, then sparsely, dense where text or shots change', () => {
  const sampleT = Array.from({ length: 41 }, (_, i) => i * 0.25)
  const none = sampleT.map(() => '')
  assert.deepEqual(previewTimes(sampleT, none, [], 10), sampleT)
  // 5 minutes: one in 10 samples (each 2.5 s), the last, both sides of a text change, around a shot.
  const long = Array.from({ length: 1201 }, (_, i) => i * 0.25)
  const text = long.map((t) => (t >= 100 && t < 100.5 ? 'title' : ''))
  const picked = previewTimes(long, text, [200], 300)
  for (const t of [0, 2.5, 297.5, 300, 99.75, 100, 100.25, 100.5, 199.5, 200, 200.5])
    assert.ok(picked.includes(t), `renders ${t}`)
  assert.ok(!picked.includes(50.25))
  assert.ok(picked.length < 150, `${picked.length} renders`)
})

test('a contact sheet without shots spreads frames sized to the film: 7 up to 70 s, at most 24', () => {
  assert.equal(sheetFrames(1), 7)
  assert.equal(sheetFrames(70), 7)
  assert.equal(sheetFrames(120), 12)
  assert.equal(sheetFrames(300), 24)
  const times = reviewTimes([], 30, 300)
  assert.equal(times.length, 25)
  assert.equal(times[1]?.label, '2/24')
})

test('review on a 5-minute film renders a tenth of the samples and still reads a text shown for 0.25 s', async () => {
  const project = memoryProject({ duration: 300 })
  let renders = 0
  const child = memoryChild({
    size: { width: 64, height: 36 },
    frame: (t, intent) => {
      if (intent === 'preview') renders++
      return boxFrame(64, 36)(t % 1)
    },
    // Between two sparse samples (2.5 s apart): on screen at 101.25 only.
    inspect: (t): Json =>
      t > 101.1 && t < 101.4
        ? { title: { id: 'title', text: 'BLINK', box: [10, 10, 20, 8], opacity: 1 } }
        : {},
  })
  const outDir = tempDir('review')
  try {
    const r = await review({ project, child, outDir, quick: true })
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]))
    assert.match(by.reading?.measured ?? '', /title "BLINK"/)
    assert.match(by['text-fit']?.measured ?? '', /^1 runs/)
    assert.ok(renders < 150, `${renders} preview renders`)
    assert.equal(r.frames.length, 25)
  } finally {
    await child.close()
  }
})
