// render-canvas-texture, headless on Dawn. Checked: a canvas uploaded reads back byte-equal to its
// getImageData, transparent and half-transparent pixels included, at a width whose rows are not
// 256-byte aligned; RGBA bytes likewise; one texture per size, written again on every upload;
// bytes of the wrong length are refused. And the five looks that import it, each laid out alone
// with what it requires, give from a canvas the very bytes they give from a texture of the same
// pixels, by sha256.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { Canvas } from '@napi-rs/canvas'
import {
  CANVAS_TEXTURE_FORMAT,
  createCanvasTexture,
} from '../render-canvas-texture/src/render/canvas-texture.ts'
import { openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

const W = 100
const H = 60

/** A canvas with a gradient, a disc, a transparent strip and a half-transparent box in it. */
const paint = (w: number, h: number, k = 0) => {
  const c = new Canvas(w, h)
  const x = c.getContext('2d')
  const g = x.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, `rgb(${20 + k * 40},40,90)`)
  g.addColorStop(1, 'rgb(250,200,60)')
  x.fillStyle = g
  x.fillRect(0, 0, w, h)
  x.fillStyle = 'rgba(255,255,255,0.6)'
  x.beginPath()
  x.arc(w * 0.4, h * 0.5, h * 0.3, 0, Math.PI * 2)
  x.fill()
  x.clearRect(0, 0, w * 0.25, h)
  x.fillStyle = 'rgba(255,40,20,0.5)'
  x.fillRect(4, 4, w * 0.15, h * 0.5)
  return c as unknown as OffscreenCanvas
}
const bytesOf = (c: OffscreenCanvas) =>
  new Uint8Array(
    (c.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(0, 0, c.width, c.height)
      .data,
  )
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

test('render-canvas-texture: a canvas and RGBA bytes read back byte-equal', async () => {
  const g = await openFrame(W, H)
  const canvases = createCanvasTexture(g.host)
  const a = paint(W, H)
  const texture = canvases.upload(a)
  assert.equal(texture.format, CANVAS_TEXTURE_FORMAT)
  assert.equal(CANVAS_TEXTURE_FORMAT, 'rgba8unorm')
  assert.deepEqual([texture.width, texture.height], [W, H])
  const want = bytesOf(a)
  assert.ok(
    want.some((v, i) => i % 4 === 3 && v > 0 && v < 255),
    'half-transparent pixels',
  )
  assert.deepEqual(await g.read(texture), want)

  // The same size is the same texture, written again.
  const b = paint(W, H, 3)
  assert.equal(canvases.upload(b), texture)
  assert.deepEqual(await g.read(texture), bytesOf(b))

  // Another size, another texture; bytes go in as they are.
  const data = new Uint8ClampedArray(7 * 3 * 4).map((_, i) => (i * 37) & 255)
  const small = canvases.upload({ data, width: 7, height: 3 })
  assert.notEqual(small, texture)
  assert.deepEqual(await g.read(small), new Uint8Array(data))
  assert.throws(() => canvases.upload({ data, width: 8, height: 3 }), /not 8×3 RGBA pixels/)

  canvases.dispose()
  g.done()
})

test('render-canvas-texture: the five looks give the same bytes from a canvas as from a texture', async () => {
  const look = async <T>(item: string, path: string) =>
    (await layOut(item, `render-canvas-texture.${item}`)(path)) as T
  const { createBlur } = await look<typeof import('../look-blur/src/looks/blur.ts')>(
    'look-blur',
    'src/looks/blur.ts',
  )
  const { createGrain } = await look<typeof import('../look-film-grain/src/looks/grain.ts')>(
    'look-film-grain',
    'src/looks/grain.ts',
  )
  const { createVignette } = await look<typeof import('../look-vignette/src/looks/vignette.ts')>(
    'look-vignette',
    'src/looks/vignette.ts',
  )
  const { createRowGlitch } = await look<
    typeof import('../look-row-glitch/src/looks/row-glitch.ts')
  >('look-row-glitch', 'src/looks/row-glitch.ts')
  const { createLooks, LOOKS } = await look<
    typeof import('../look-screen-passes/src/looks/looks.ts')
  >('look-screen-passes', 'src/looks/looks.ts')

  const g = await openFrame(W, H)
  const canvas = paint(W, H, 1)
  const map = paint(W, H, 2)
  /** The canvas's pixels as a texture made without the plugin: the path the looks always had. */
  const textureOf = (c: OffscreenCanvas) => {
    const t = g.device.createTexture({
      size: [W, H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    g.device.queue.writeTexture({ texture: t }, bytesOf(c), { bytesPerRow: W * 4 }, [W, H])
    return t
  }
  const source = textureOf(canvas)
  const mapTexture = textureOf(map)
  const same = async (what: string, run: (s: GPUTexture | OffscreenCanvas) => GPUTexture) => {
    const fromTexture = sha(await g.read(run(source)))
    const fromCanvas = sha(await g.read(run(canvas)))
    assert.equal(fromCanvas, fromTexture, what)
  }

  const size = { width: W, height: H }
  const blur = createBlur(g.host, size)
  for (const kind of ['gaussian', 'bokeh', 'directional', 'radial'] as const)
    await same(`look-blur ${kind}`, (s) =>
      blur.apply(s, { kind, radius: 8, alpha: 'straight', map: s === canvas ? map : mapTexture }),
    )
  const grain = createGrain(g.host, size)
  await same('look-film-grain', (s) => grain.apply(s, { amount: 0.1, seed: 3 }))
  const vignette = createVignette(g.host, size)
  await same('look-vignette', (s) => vignette.apply(s, { amount: 0.7, color: [0.2, 0.1, 0.5] }))
  const glitch = createRowGlitch(g.host, size)
  await same('look-row-glitch', (s) => glitch.apply(s, { rows: 0.6, sort: 1, seed: 5 }))
  const looks = createLooks(g.host, { ...size, face: 'monospace' })
  for (const name of LOOKS)
    await same(`look-screen-passes ${name}`, (s) => looks.apply(s, { look: name }))

  for (const d of [blur, grain, vignette, glitch, looks]) d.dispose()
  g.done()
})
