// composite-matte, headless on Dawn. Checked: a luma matte keeps the source where it is white,
// cuts where black and halves at a luma of 0.5 (Rec. 709 weights); invert turns it over; an alpha
// matte ignores colour; a transparent luma matte cuts; the source's own alpha is kept;
// premultiplied inputs read as such; a canvas works; a missing channel and a wrong size throw.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Canvas } from '@napi-rs/canvas'
import { openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

const { createMatte } = (await layOut('composite-matte')(
  'src/composite/matte.ts',
)) as typeof import('../composite-matte/src/composite/matte.ts')

const W = 32
const H = 16

test('composite-matte: luma, alpha, invert, inputs and errors', async () => {
  const g = await openFrame(W, H)
  const matte = createMatte(g.host, { width: W, height: H })
  const opaque = (t: GPUTexture) => ({ color: t, alpha: 'opaque' as const })
  const source = g.frame(() => [200, 100, 50, 255])
  // left third white, middle third black, right third pure green (luma 0.7152)
  const mask = g.frame((x) =>
    x < 11 ? [255, 255, 255, 255] : x < 22 ? [0, 0, 0, 255] : [0, 255, 0, 255],
  )

  const luma = await g.read(
    matte.apply(opaque(source.texture), opaque(mask.texture), { channel: 'luma' }),
  )
  assert.deepEqual([...luma.slice(0, 4)], [200, 100, 50, 255], 'white keeps')
  assert.equal(g.at(luma, 15, 0, 3), 0, 'black cuts')
  assert.ok(Math.abs(g.at(luma, 28, 0, 3) - 0.7152 * 255) <= 1, 'green keeps by its luma')
  assert.ok(Math.abs(g.at(luma, 28, 0, 0) - 200 * 0.7152) <= 1.5, 'premultiplied out')

  const inv = await g.read(
    matte.apply(opaque(source.texture), opaque(mask.texture), { channel: 'luma', invert: true }),
  )
  assert.ok(g.at(inv, 0, 0, 3) === 0 && g.at(inv, 15, 0, 3) === 255, 'invert turns it over')

  const alpha = await g.read(
    matte.apply(opaque(source.texture), opaque(mask.texture), { channel: 'alpha' }),
  )
  assert.ok(
    [0, 15, 28].every((x) => g.at(alpha, x, 0, 3) === 255),
    'an alpha matte ignores colour',
  )

  const clear = g.frame(() => [255, 255, 255, 0])
  const cut = await g.read(
    matte.apply(
      opaque(source.texture),
      { color: clear.texture, alpha: 'straight' },
      { channel: 'luma' },
    ),
  )
  assert.equal(g.at(cut, 0, 0, 3), 0, 'a transparent luma matte cuts')

  // a half-transparent source, premultiplied: its alpha is kept under a white matte
  const half = g.frame(() => [100, 50, 25, 128])
  const kept = await g.read(
    matte.apply({ color: half.texture, alpha: 'premultiplied' }, opaque(mask.texture), {
      channel: 'luma',
    }),
  )
  assert.deepEqual([...kept.slice(0, 4)], [100, 50, 25, 128], "the source's alpha is kept")

  const canvas = new Canvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W / 2, H)
  const fromCanvas = await g.read(
    matte.apply(opaque(source.texture), canvas as unknown as OffscreenCanvas, { channel: 'alpha' }),
  )
  assert.ok(
    g.at(fromCanvas, 2, 2, 3) === 255 && g.at(fromCanvas, W - 2, 2, 3) === 0,
    'a canvas matte',
  )

  assert.throws(
    () => matte.apply(opaque(source.texture), opaque(mask.texture), {} as { channel: 'luma' }),
    /channel is 'luma' or 'alpha'/,
  )
  const small = g.device.createTexture({
    size: [8, 8],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  })
  assert.throws(
    () => matte.apply(opaque(source.texture), opaque(small), { channel: 'luma' }),
    /8×8/,
  )
  matte.dispose()
  g.done()
})
