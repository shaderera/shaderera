// look-vignette, headless on Dawn. Checked: amount 0 is the frame; the centre is untouched and a
// corner goes the amount towards black in linear light; on a wide frame the frame-shaped one
// reaches top and bottom sooner than a round one; the colour can be white; the centre can move.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createVignette } from '../look-vignette/src/looks/vignette.ts'
import { grey, openFrame } from './frame.ts'

const W = 160
const H = 90
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

test('look-vignette: amount, shape, colour and centre', async () => {
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
  const light = await g.read(vignette.apply(black.texture, { amount: 0.8, colour: [1, 1, 1] }))
  assert.ok(g.at(light, 0, 0) > 200 && g.at(light, W / 2, H / 2) === 0, 'towards white')

  const moved = await g.read(
    vignette.apply(white.texture, { amount: 1, centre: [0, 0], start: 0.2 }),
  )
  assert.ok(g.at(moved, 0, 0) === 255 && g.at(moved, W - 1, H - 1) < 50, 'from a moved centre')
  vignette.dispose()
  g.done()
})
