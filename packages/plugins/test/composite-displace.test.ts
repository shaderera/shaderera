// composite-displace, headless on Dawn. Checked: a 0.5 map (and amount 0) gives the source back;
// a white map moves the source right and down by amount, a black one left and up; luma and the
// other channels pick the axis; a half-pixel move mixes neighbours; clamp, wrap and transparent at
// the edges; a straight source is mixed premultiplied (no halo); a canvas map works; bad
// parameters and a wrong size throw.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Canvas } from '@napi-rs/canvas'
import { openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

const { createDisplace } = (await layOut('composite-displace')(
  'src/composite/displace.ts',
)) as typeof import('../composite-displace/src/composite/displace.ts')

const W = 32
const H = 16

test('composite-displace: direction, amount, channels, edges, inputs and errors', async () => {
  const g = await openFrame(W, H)
  const displace = createDisplace(g.host, { width: W, height: H })
  const opaque = (t: GPUTexture) => ({ color: t, alpha: 'opaque' as const })
  // each column and row its own value: red = 8·x, green = 16·y
  const { texture: src, px } = g.frame((x, y) => [x * 8, y * 16, 100, 255])
  // a float map: the exact 0.5 grey a byte cannot hold
  const mapOf = (r: number, gr: number, b = 0.5, a = 1) => {
    const t = g.device.createTexture({
      size: [W, H],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const d = new Float32Array(W * H * 4)
    for (let i = 0; i < W * H; i++) d.set([r, gr, b, a], i * 4)
    g.device.queue.writeTexture({ texture: t }, d, { bytesPerRow: W * 16 }, [W, H])
    return { color: t, alpha: 'straight' as const }
  }
  const both = (amount: number) => ({
    x: { channel: 'red' as const, amount },
    y: { channel: 'green' as const, amount },
  })

  const still = await g.read(displace.apply(opaque(src), mapOf(0.5, 0.5), both(10)))
  assert.deepEqual([...still], [...px], 'a 0.5 map gives the source back')
  const zero = await g.read(displace.apply(opaque(src), mapOf(1, 0), both(0)))
  assert.deepEqual([...zero], [...px], 'amount 0 gives the source back')

  const right = await g.read(displace.apply(opaque(src), mapOf(1, 1), both(3)))
  assert.equal(g.at(right, 10, 5, 0), 7 * 8, 'white moves right by amount')
  assert.equal(g.at(right, 10, 5, 1), 2 * 16, 'and down')
  const left = await g.read(displace.apply(opaque(src), mapOf(0, 0), both(3)))
  assert.ok(
    g.at(left, 10, 5, 0) === 13 * 8 && g.at(left, 10, 5, 1) === 8 * 16,
    'black moves left and up',
  )

  const lumaX = await g.read(
    displace.apply(opaque(src), mapOf(1, 1, 1), { x: { channel: 'luma', amount: 2 } }),
  )
  assert.ok(
    g.at(lumaX, 10, 5, 0) === 8 * 8 && g.at(lumaX, 10, 5, 1) === 5 * 16,
    'luma moves x only',
  )
  const blueY = await g.read(
    displace.apply(opaque(src), mapOf(0.5, 0.5, 1), { y: { channel: 'blue', amount: 2 } }),
  )
  assert.equal(g.at(blueY, 10, 5, 1), 3 * 16, 'blue picks y')

  const half = await g.read(displace.apply(opaque(src), mapOf(0.75, 0.5), both(1)))
  assert.ok(Math.abs(g.at(half, 10, 5, 0) - 9.5 * 8) <= 1, 'half a pixel mixes neighbours')

  const clamp = await g.read(displace.apply(opaque(src), mapOf(1, 0.5), both(4)))
  assert.equal(g.at(clamp, 1, 5, 0), 0, 'clamp shows the edge pixel')
  const wrap = await g.read(
    displace.apply(opaque(src), mapOf(1, 0.5), { ...both(4), edges: 'wrap' }),
  )
  assert.equal(g.at(wrap, 1, 5, 0), (W - 3) * 8, 'wrap shows the other side')
  const gone = await g.read(
    displace.apply(opaque(src), mapOf(1, 0.5), { ...both(4), edges: 'transparent' }),
  )
  assert.equal(g.at(gone, 1, 5, 3), 0, 'transparent shows nothing')

  // white opaque next to transparent black, straight: half way is white at half alpha, not grey
  const edge = g.frame((x) => (x < 16 ? [255, 255, 255, 255] : [0, 0, 0, 0]))
  const mixed = await g.read(
    displace.apply({ color: edge.texture, alpha: 'straight' }, mapOf(0.25, 0.5), both(1)),
  )
  assert.ok(
    Math.abs(g.at(mixed, 15, 5, 3) - 127.5) <= 1 && Math.abs(g.at(mixed, 15, 5, 0) - 127.5) <= 1,
    'premultiplied mix: no halo',
  )

  const canvas = new Canvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  const fromCanvas = await g.read(
    displace.apply(opaque(src), canvas as unknown as OffscreenCanvas, {
      x: { channel: 'red', amount: 2 },
    }),
  )
  assert.equal(g.at(fromCanvas, 10, 5, 0), 8 * 8, 'a canvas map')

  assert.throws(() => displace.apply(opaque(src), mapOf(1, 1), {}), /give x, y or both/)
  assert.throws(
    () => displace.apply(opaque(src), mapOf(1, 1), { x: { channel: 'cyan' as 'red', amount: 1 } }),
    /x.channel/,
  )
  assert.throws(
    () => displace.apply(opaque(src), mapOf(1, 1), { ...both(1), edges: 'mirror' as 'wrap' }),
    /edges is/,
  )
  const small = g.device.createTexture({
    size: [8, 8],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  })
  assert.throws(() => displace.apply(opaque(src), opaque(small), both(1)), /8×8/)
  displace.dispose()
  g.done()
})
