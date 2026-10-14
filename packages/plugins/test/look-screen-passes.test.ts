// look-screen-passes, headless on Dawn: what each medium must do, not only that it changes the
// frame. Pixels gives each block its mean; dither keeps a grey's mean in levels; a halftone dot's
// area is the brightness; ASCII cells are as wide as `cell`; contours draw lines where the
// brightness crosses a step and nothing on flat ground between; heat follows its palette; inverse
// turns every value over; ink and paper are the colours drawn with; amount 0 is the frame.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { GlobalFonts } from '@napi-rs/canvas'
import { createLooks, LOOKS } from '../look-screen-passes/src/looks/looks.ts'
import { grey, openFrame } from './frame.ts'

GlobalFonts.registerFromPath(
  join(
    import.meta.dirname,
    '..',
    'font-ibm-plex-mono',
    'assets',
    'fonts',
    'IBMPlexMono-Regular.ttf',
  ),
  'Plex',
)

const W = 128
const H = 64

test('look-screen-passes: each medium does what it says', async () => {
  const g = await openFrame(W, H)
  const looks = createLooks(g.host, { width: W, height: H, face: 'Plex' })
  // Noise: every pixel its own grey, so a block's mean is not any one of its pixels.
  const noise = g.frame((x, y) => grey((x * 73 + y * 151 + ((x * y) % 7) * 31) % 256))
  const flat = g.frame(() => grey(140))
  const ramp = g.frame((x) => grey(Math.round((x / (W - 1)) * 255)))

  // Pixels: an 8 px block is its pixels' mean.
  const pixels = await g.read(looks.apply(noise.texture, { look: 'pixels', cell: 8 }))
  for (const [bx, by] of [
    [0, 0],
    [3, 2],
    [15, 7],
  ] as const) {
    let sum = 0
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) sum += g.at(noise.px, bx * 8 + x, by * 8 + y)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        assert.ok(Math.abs(g.at(pixels, bx * 8 + x, by * 8 + y) - sum / 64) <= 1, 'the block mean')
  }

  // Dither: only paper and ink at two levels, and the grey's mean kept.
  const dither = await g.read(looks.apply(flat.texture, { look: 'dither' }))
  let on = 0
  for (let i = 0; i < W * H; i++) {
    const v = dither[i * 4] ?? -1
    assert.ok(v === 0 || v === 255, 'one bit')
    if (v === 255) on++
  }
  assert.ok(Math.abs(on / (W * H) - 140 / 255) < 0.02, `dither keeps the mean (${on / (W * H)})`)

  // Halftone: the ink covers as much as the brightness.
  const halftone = await g.read(looks.apply(flat.texture, { look: 'halftone', cell: 8 }))
  let ink = 0
  for (let i = 0; i < W * H; i++) ink += (halftone[i * 4] ?? 0) / 255
  assert.ok(Math.abs(ink / (W * H) - 140 / 255) < 0.04, `dot area (${ink / (W * H)})`)

  // ASCII: cells are cell px wide, so a flat grey repeats every 12 px.
  const ascii = await g.read(looks.apply(flat.texture, { look: 'ascii', cell: 12 }))
  let lit = 0
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 96; x++) {
      assert.equal(g.at(ascii, x, y), g.at(ascii, x + 12, y), 'a 12 px cell')
      if (g.at(ascii, x, y) > 0) lit++
    }
  assert.ok(lit > 0, 'glyphs are drawn')

  // Contours: lines on a ramp, at each of the bands' steps; none on flat ground between steps.
  const flatLines = await g.read(looks.apply(flat.texture, { look: 'contours', bands: 4 }))
  assert.ok(
    flatLines.every((v, i) => i % 4 === 3 || v === 0),
    'no line on flat ground',
  )
  const lines = await g.read(looks.apply(ramp.texture, { look: 'contours', bands: 4 }))
  let crossings = 0
  for (let x = 1; x < W; x++)
    if (g.at(lines, x, 30) > 128 && g.at(lines, x - 1, 30) <= 128) crossings++
  assert.equal(crossings, 3, 'a line at each inner step of four bands')

  // Heat: a two-colour palette from red to blue.
  const heat = await g.read(
    looks.apply(ramp.texture, {
      look: 'heat',
      palette: [
        [1, 0, 0],
        [0, 0, 1],
      ],
    }),
  )
  assert.deepEqual([g.at(heat, 0, 0, 0), g.at(heat, 0, 0, 2)], [255, 0])
  assert.deepEqual([g.at(heat, W - 1, 0, 0), g.at(heat, W - 1, 0, 2)], [0, 255])

  // Inverse, and amount 0.
  const inverse = await g.read(looks.apply(noise.texture, { look: 'inverse' }))
  assert.ok(noise.px.every((v, i) => i % 4 === 3 || Math.abs((inverse[i] ?? 0) - (255 - v)) <= 1))
  assert.deepEqual(
    await g.read(looks.apply(noise.texture, { look: 'halftone', amount: 0 })),
    noise.px,
  )

  // Ink and paper: black ground is paper, the dots ink.
  const black = g.frame(() => grey(0))
  const paper = await g.read(
    looks.apply(black.texture, { look: 'halftone', ink: [0, 0, 0], paper: [1, 0.6, 0] }),
  )
  assert.deepEqual(
    [g.at(paper, 9, 9, 0), g.at(paper, 9, 9, 1), g.at(paper, 9, 9, 2)],
    [255, 153, 0],
  )

  // Every look runs; a bad one, palette or ramp is refused.
  for (const look of LOOKS) await g.read(looks.apply(noise.texture, { look }))
  assert.throws(() => looks.apply(noise.texture, { look: 'none' as never }), /no look "none"/)
  assert.throws(
    () => looks.apply(noise.texture, { look: 'heat', palette: [[0, 0, 0]] }),
    /a palette of 2 to 8/,
  )
  assert.throws(() => createLooks(g.host, { width: W, height: H, face: 'Plex', ramp: '#' }), /ramp/)
  looks.dispose()
  g.done()
})
