// text-fit: copied into a project the way `add` lays it out, measured on a real canvas in a real
// font, and on a stand-in context whose every character is 10 px wide, so lines are counted. The
// runs it makes go through review, on the CLI's in-memory fixture, as a film's inspect.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Canvas, GlobalFonts } from '@napi-rs/canvas'
import { memoryChild, memoryProject } from '../../../apps/cli/src/node/fixtures/memory-child.ts'
import { review } from '../../../apps/cli/src/review/review.ts'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'text-fit')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'text-fit', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'text-fit', f), join(project, f))
}
const { fitSize, fitWidth, textRuns, trackedWidth, wrap } = (await import(
  pathToFileURL(join(project, 'src/type/fit.ts')).href
)) as typeof import('../text-fit/src/type/fit.ts')

type Ctx = OffscreenCanvasRenderingContext2D
const fonts = join(plugins, 'font-ibm-plex-mono', 'assets', 'fonts')
GlobalFonts.registerFromPath(join(fonts, 'IBMPlexMono-SemiBold.ttf'), 'Plex Bold')
GlobalFonts.registerFromPath(
  join(plugins, 'font-ibm-plex-sans', 'assets', 'fonts', 'IBMPlexSans-Regular.ttf'),
  'Plex Sans',
)
const real = () => new Canvas(10, 10).getContext('2d') as unknown as Ctx
/** A context whose every UTF-16 unit is 10 px wide. */
const tens = () => ({ font: '', measureText: (s: string) => ({ width: s.length * 10 }) }) as Ctx

test('text-fit: fitWidth and fitSize give what they gave in text-kinetic', () => {
  const ctx = real()
  // Measured with text-kinetic 0.1.0's fitWidth, before the move.
  assert.equal(fitWidth(ctx, '"Plex Bold"', 'GLITCH', 400), 111.11111111111111)
  assert.equal(fitWidth(ctx, '"Plex Bold"', 'BEAT GRID', 1000), 185.1851851851852)
  assert.equal(fitWidth(ctx, '"Plex Sans"', 'Wallpaper', 640), 140.2278721645114)
  assert.equal(fitSize(ctx, '"Plex Sans"', 'Wallpaper', 80, 640), 80)
  assert.equal(fitSize(ctx, '"Plex Sans"', 'Wallpaper', 500, 640), 140.2278721645114)
  // It sets the font only to measure.
  ctx.font = '12px "Plex Sans"'
  fitWidth(ctx, '"Plex Bold"', 'GLITCH', 400)
  assert.equal(ctx.font, '12px "Plex Sans"')
})

test('text-fit: no wrapped line is wider than the width unless it is one word', () => {
  const text =
    'Greedy wrap, at word boundaries: (each line) takes as many words as fit, and an ' +
    'extraordinarily-long-compound word gets a line of its own. Then it goes on.'
  const ctx = real()
  ctx.font = '24px "Plex Sans"'
  for (const width of [60, 120, 200, 333, 500, 1000]) {
    const lines = wrap(ctx, text, width)
    assert.equal(lines.join(' '), text, `nothing lost at ${width}`)
    for (const line of lines)
      if (ctx.measureText(line).width > width)
        assert.ok(!line.includes(' '), `"${line}" is over ${width} and is not one word`)
  }
  // Punctuation stays with its word; a new line starts it.
  assert.deepEqual(wrap(tens(), 'one, (two) three', 90), ['one,', '(two)', 'three'])
  assert.deepEqual(wrap(tens(), 'a b\nc d', 1000), ['a b', 'c d'])
  // Tracking counts: 'ab cd' is 50 px, plus 4 gaps of 3.
  assert.deepEqual(wrap(tens(), 'ab cd', 55), ['ab cd'])
  assert.deepEqual(wrap(tens(), 'ab cd', 55, { tracking: 3 }), ['ab', 'cd'])
})

test('text-fit: Thai, with no spaces between words, wraps at the segmenter boundaries', () => {
  const text = 'ภาษาไทยไม่มีช่องว่างระหว่างคำ'
  const words = [...new Intl.Segmenter('th', { granularity: 'word' }).segment(text)].map(
    (s) => s.segment,
  )
  assert.ok(words.length > 3)
  const lines = wrap(tens(), text, 100, { locale: 'th' })
  assert.ok(lines.length > 1)
  assert.equal(lines.join(''), text)
  // Each line is whole words: its end is a boundary.
  const ends = (parts: string[]) => parts.map((_, i) => parts.slice(0, i + 1).join('').length)
  const boundaries = new Set(ends(words))
  for (const [i, end] of ends(lines).entries())
    assert.ok(boundaries.has(end), `"${lines[i]}" ends in a word`)
})

test('text-fit: trackedWidth adds the tracking between graphemes', () => {
  assert.equal(trackedWidth(tens(), 'ABCD'), 40)
  assert.equal(trackedWidth(tens(), 'ABCD', 5), 55)
  assert.equal(trackedWidth(tens(), '', 5), 0)
  // กี่ is three code points and one grapheme: one gap between it and ก.
  assert.equal(trackedWidth(tens(), 'กี่ก', 5), 45)
  const ctx = real()
  ctx.font = '100px "Plex Sans"'
  const w = trackedWidth(ctx, 'SLOGAN', 10)
  ctx.letterSpacing = '10px'
  assert.ok(
    Math.abs(ctx.measureText('SLOGAN').width - 10 - w) < 0.01,
    'as letterSpacing, less the last',
  )
})

test('text-fit: textRuns are the wrapped lines, measured, and pass the text fit of review', async () => {
  const ctx = real()
  ctx.font = '12px "Plex Sans"'
  const font = '24px "Plex Sans"'
  const copy = 'Built for the last mile, wrapped in a column and handed to review as text runs.'
  ctx.font = font
  const lines = wrap(ctx, copy, 300)
  ctx.font = '12px "Plex Sans"'
  const runs = textRuns(ctx, lines, [40, 30], { id: 'body', lineHeight: 32, width: 300, font })
  assert.equal(ctx.font, '12px "Plex Sans"', 'the font is put back')
  assert.ok(lines.length > 2)
  ctx.font = font
  assert.deepEqual(
    runs,
    lines.map((text, i) => ({
      id: `body.${i}`,
      text,
      box: [40, 30 + i * 32, ctx.measureText(text).width, 32],
      font,
    })),
  )

  const project = memoryProject({ width: 640, height: 360 })
  const child = memoryChild({ size: { width: 640, height: 360 }, inspect: () => ({ body: runs }) })
  try {
    const safeArea = { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }
    const r = await review({
      project,
      child,
      outDir: join(plugins, 'out', 'text-fit-review'),
      quick: true,
      requirements: { version: 1, safeArea },
    })
    const fit = r.checks.find((c) => c.id === 'text-fit')
    assert.equal(fit?.status, 'pass', fit?.detail)
    assert.match(fit?.measured ?? '', new RegExp(`^${lines.length} runs at `))
  } finally {
    await child.close()
  }
})

test('text-fit: textRuns align in the width, track, and skip blank lines', () => {
  const runs = (align: 'left' | 'center' | 'right', tracking?: number) =>
    textRuns(tens(), ['abc', '', 'a'], [100, 0], {
      id: 't',
      lineHeight: 20,
      width: 60,
      align,
      tracking,
    })
  assert.deepEqual(
    runs('right').map((r) => [r.id, r.box]),
    [
      ['t.0', [130, 0, 30, 20]],
      ['t.2', [150, 40, 10, 20]],
    ],
  )
  assert.deepEqual(runs('center')[0]?.box, [115, 0, 30, 20])
  // 'abc' tracked 5: 30 + 2 gaps.
  assert.deepEqual(runs('left', 5)[0]?.box, [100, 0, 40, 20])
})
