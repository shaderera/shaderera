// look-vignette, headless on Dawn. Checked: amount 0 is the frame; the centre is untouched and a
// corner goes the amount towards black in linear light; on a wide frame the frame-shaped one
// reaches top and bottom sooner than a round one; the colour can be white; the centre can move; an
// ellipse of a given size leaves its inside untouched and dims outside it by the amount, and at
// [0, 0] dims everything.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { grey, openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

const { createVignette } = (await layOut('look-vignette')(
  'src/looks/vignette.ts',
)) as typeof import('../look-vignette/src/looks/vignette.ts')

const W = 160
const H = 90
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

test('look-vignette: amount, shape, colour, centre and size', async () => {
  const g = await openFrame(W, H)
  const vignette = createVignette(g.host, { width: W, height: H })
  const white = g.frame(() => grey(255))
  const { texture, px } = g.frame((x, y) => grey((x * 3 + y * 5) % 256))

  const plain = await g.read(vignette.apply(texture, { amount: 0 }))
  assert.ok(
    px.every((v, i) => Math.abs((plain[i] ?? 0) - v) <= 1),
    'amount 0 is the frame',
  )

  const v = await g.read(vignette.apply(white.texture, { amount: 0.5 }))
  assert.equal(g.at(v, W / 2, H / 2), 255, 'the centre is untouched')
  assert.ok(
    Math.abs(g.at(v, 0, 0) - toSrgb(0.5) * 255) <= 2,
    'a corner is half way, in linear light',
  )

  const round = await g.read(vignette.apply(white.texture, { amount: 1, roundness: 1, start: 0.3 }))
  const frame = await g.read(vignette.apply(white.texture, { amount: 1, roundness: 0, start: 0.3 }))
  assert.ok(
    g.at(frame, W / 2, 0) < g.at(round, W / 2, 0),
    'the frame shape reaches top and bottom sooner',
  )

  const black = g.frame(() => grey(0))
  const light = await g.read(vignette.apply(black.texture, { amount: 0.8, color: [1, 1, 1] }))
  assert.ok(g.at(light, 0, 0) > 200 && g.at(light, W / 2, H / 2) === 0, 'towards white')

  const moved = await g.read(
    vignette.apply(white.texture, { amount: 1, centre: [0, 0], start: 0.2 }),
  )
  assert.ok(g.at(moved, 0, 0) === 255 && g.at(moved, W - 1, H - 1) < 50, 'from a moved centre')

  const spot = await g.read(
    vignette.apply(white.texture, { amount: 0.5, centre: [40, 45], size: [20, 10], start: 0.5 }),
  )
  assert.ok(
    g.at(spot, 40, 45) === 255 && g.at(spot, 49, 45) === 255 && g.at(spot, 40, 49) === 255,
    'inside the ellipse is untouched',
  )
  const half = toSrgb(0.5) * 255
  assert.ok(
    [g.at(spot, 61, 45), g.at(spot, 40, 56), g.at(spot, W - 1, H - 1)].every(
      (v) => Math.abs(v - half) <= 2,
    ),
    'outside the ellipse is dimmed by the amount',
  )
  const closed = await g.read(
    vignette.apply(white.texture, { amount: 0.5, centre: [40, 45], size: [0, 0], start: 0.5 }),
  )
  assert.ok(Math.abs(g.at(closed, 40, 45) - half) <= 2, 'a closed ellipse dims everything')
  vignette.dispose()
  g.done()
})
