import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { open } from '../cli/args.ts'
import { readingShort, review, reviewTimes } from './review.ts'

/** A fixture in its own temp folder: test files run in parallel, and each build empties `.shaderera/`. */
const copy = (dir: string) => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-fixture-'))
  cpSync(fileURLToPath(new URL(dir, import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}
const fixture = copy('../cli/fixtures/mcp/')

test('review (quick) on a fixture without shots or text: measured or unknown, never a fake pass', async () => {
  const { project, child } = await open({ root: fixture })
  const outDir = mkdtempSync(join(tmpdir(), 'review-'))
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
