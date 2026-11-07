// composite-blend, headless on Dawn. Checked: every mode, in display values and in linear light,
// gives the CPU's values on a grid of colours and alphas; the spec's values at known points
// (multiply, screen, soft light at mid grey); amount 0 is the base; a transparent layer leaves the
// base and a transparent base shows the layer; premultiplied and opaque inputs read as such; a
// canvas input works; an unknown mode and a wrong size throw.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Canvas } from '@napi-rs/canvas'
import { openFrame, type Rgba } from './frame.ts'
import { layOut } from './lay-out.ts'

const { createBlend, blendPixel, BLEND_MODES } = (await layOut('composite-blend')(
  'src/composite/blend.ts',
)) as typeof import('../composite-blend/src/composite/blend.ts')

const W = 64
const H = 48
// A spread of straight colours and alphas, base and layer different at every pixel.
const baseAt = (x: number, y: number): Rgba => [
  (x * 37 + y * 11) % 256,
  (x * 13 + y * 29) % 256,
  (x * 7 + y * 53) % 256,
  y < 8 ? 255 : (x * 41 + y * 17) % 256,
]
const layerAt = (x: number, y: number): Rgba => [
  (x * 23 + y * 31) % 256,
  (x * 47 + y * 5) % 256,
  (x * 19 + y * 43) % 256,
  y < 8 ? 255 : (x * 29 + y * 59) % 256,
]
const unit = (c: Rgba) => c.map((v) => v / 255) as unknown as Rgba

test('composite-blend: every mode gives the CPU values, in display and linear', async () => {
  const g = await openFrame(W, H)
  const blend = createBlend(g.host, { width: W, height: H })
  const base = g.frame(baseAt)
  const layer = g.frame(layerAt)
  for (const space of ['display', 'linear'] as const)
    for (const mode of BLEND_MODES) {
      const params = { mode, amount: 0.8, space }
      const got = await g.read(
        blend.apply(
          { color: base.texture, alpha: 'straight' },
          { color: layer.texture, alpha: 'straight' },
          params,
        ),
      )
      let worst = 0
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const want = blendPixel(unit(baseAt(x, y)), unit(layerAt(x, y)), params)
          for (let c = 0; c < 4; c++)
            worst = Math.max(worst, Math.abs(g.at(got, x, y, c) - (want[c] as number) * 255))
        }
      assert.ok(worst <= 1.5, `${mode} in ${space}: off by ${worst.toFixed(2)}`)
    }
  blend.dispose()
  g.done()
})

test('composite-blend: the spec at known points', () => {
  const grey = (v: number): Rgba => [v, v, v, 1]
  const near = (a: Rgba, v: number) =>
    assert.ok(Math.abs((a[0] as number) - v) < 1e-9, `${a[0]} ≠ ${v}`)
  near(blendPixel(grey(0.5), grey(0.5), { mode: 'multiply' }), 0.25)
  near(blendPixel(grey(0.5), grey(0.5), { mode: 'screen' }), 0.75)
  near(blendPixel(grey(0.3), grey(0.5), { mode: 'soft-light' }), 0.3)
  near(blendPixel(grey(0.25), grey(1), { mode: 'soft-light' }), 0.5)
  near(blendPixel(grey(0.6), grey(0.6), { mode: 'add' }), 1)
  near(blendPixel(grey(0.2), grey(0.9), { mode: 'normal', amount: 0 }), 0.2)
  // a gray layer by luminosity over red keeps the grey's luminosity
  const l = blendPixel([1, 0, 0, 1], grey(0.5), { mode: 'luminosity' })
  assert.ok(Math.abs(0.3 * l[0] + 0.59 * l[1] + 0.11 * l[2] - 0.5) < 1e-9)
})

test('composite-blend: amount, alpha kinds, canvases and errors', async () => {
  const g = await openFrame(W, H)
  const blend = createBlend(g.host, { width: W, height: H })
  const base = g.frame(() => [200, 100, 50, 255])
  const layer = g.frame(() => [10, 220, 90, 255])
  const clear = g.frame(() => [0, 0, 0, 0])
  const opaque = (t: GPUTexture) => ({ color: t, alpha: 'opaque' as const })

  const none = await g.read(
    blend.apply(opaque(base.texture), opaque(layer.texture), { mode: 'multiply', amount: 0 }),
  )
  assert.deepEqual([...none.slice(0, 4)], [200, 100, 50, 255], 'amount 0 is the base')

  const holes = await g.read(
    blend.apply(
      opaque(base.texture),
      { color: clear.texture, alpha: 'straight' },
      { mode: 'screen' },
    ),
  )
  assert.deepEqual(
    [...holes.slice(0, 4)],
    [200, 100, 50, 255],
    'a transparent layer leaves the base',
  )

  const alone = await g.read(
    blend.apply({ color: clear.texture, alpha: 'premultiplied' }, opaque(layer.texture), {
      mode: 'multiply',
    }),
  )
  assert.deepEqual([...alone.slice(0, 4)], [10, 220, 90, 255], 'no base shows the layer as it is')

  // half-transparent white, premultiplied, read as such: normal at full amount gives the same
  const half = g.frame(() => [128, 128, 128, 128])
  const pm = await g.read(
    blend.apply(
      opaque(base.texture),
      { color: half.texture, alpha: 'premultiplied' },
      { mode: 'normal' },
    ),
  )
  const want = blendPixel([200 / 255, 100 / 255, 50 / 255, 1], [1, 1, 1, 128 / 255], {
    mode: 'normal',
  })
  assert.ok(Math.abs(g.at(pm, 0, 0) - (want[0] as number) * 255) <= 1.5, 'premultiplied input')

  const canvas = new Canvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgb(10, 220, 90)'
  ctx.fillRect(0, 0, W, H)
  const fromCanvas = await g.read(
    blend.apply(opaque(base.texture), canvas as unknown as OffscreenCanvas, { mode: 'multiply' }),
  )
  const m = blendPixel([200 / 255, 100 / 255, 50 / 255, 1], [10 / 255, 220 / 255, 90 / 255, 1], {
    mode: 'multiply',
  })
  assert.ok(
    Math.abs(g.at(fromCanvas, 5, 5, 1) - (m[1] as number) * 255) <= 1.5,
    'a canvas as the layer',
  )

  assert.throws(
    () => blend.apply(opaque(base.texture), opaque(layer.texture), { mode: 'grunge' as 'normal' }),
    /no mode "grunge"/,
  )
  const small = g.device.createTexture({
    size: [8, 8],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  })
  assert.throws(() => blend.apply(opaque(base.texture), opaque(small), { mode: 'normal' }), /8×8/)
  blend.dispose()
  g.done()
})
