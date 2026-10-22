// look-blur, headless on Dawn. Checked: a pixel at amount 0 (everywhere, or inside a sharp window,
// or where the map or depth says so) comes back exactly; a Gaussian's σ is half the radius; a
// bright point opens into a flat disc of the radius, and blades change its shape; a directional
// smear runs along its angle only; a radial one grows away from its centre; a canvas with
// transparency comes out premultiplied; and the same call gives the same bytes.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Canvas } from '@napi-rs/canvas'
import type { Host } from '@shaderera/core'
import { readTexture } from '@shaderera/core/gpu'
import { create, globals } from 'webgpu'
import type { BlurParams } from '../look-blur/src/looks/blur.ts'
import { layOut } from './lay-out.ts'

Object.assign(globalThis, globals)
const { createBlur } = (await layOut('look-blur')(
  'src/looks/blur.ts',
)) as typeof import('../look-blur/src/looks/blur.ts')

// Dawn's instance must outlive every pending readback, so it is held here and not in the test.
const gpu = create([])

const open = async (W: number, H: number) => {
  const adapter = await gpu.requestAdapter()
  assert.ok(adapter, 'a WebGPU adapter')
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (e) =>
    errors.push((e as GPUUncapturedErrorEvent).error.message),
  )
  const host = {
    manifest: { entry: '', width: W, height: H, fps: 30, duration: 1 },
    gpu: device,
    io: { canvas: (w: number, h: number) => new Canvas(w, h) as unknown as OffscreenCanvas },
  } as unknown as Host
  const blur = createBlur(host, { width: W, height: H })
  /** An opaque source texture from a function of the pixel, 0–255 grey. */
  const source = (grey: (x: number, y: number) => number) => {
    const texture = device.createTexture({
      size: [W, H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const px = new Uint8Array(W * H * 4)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = Math.round(grey(x, y))
        px.set([v, v, v, 255], (y * W + x) * 4)
      }
    device.queue.writeTexture({ texture }, px, { bytesPerRow: W * 4 }, [W, H])
    return { texture, px }
  }
  const run = (src: GPUTexture | OffscreenCanvas, p: BlurParams) =>
    readTexture(device, blur.apply(src, { alpha: 'opaque', ...p }))
  const done = () => {
    blur.dispose()
    device.destroy()
    assert.deepEqual(errors, [])
  }
  return { device, source, run, done }
}

const toLinear = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** The pattern every test blurs: fine stripes and a ramp, so any blur changes it. */
const stripes = (x: number, y: number) => ((x >> 1) % 2 ? 230 : 20) * 0.6 + y * 0.8

test('look-blur: amount 0 is the source exactly, inside a window, a map and depth', async () => {
  const W = 96
  const H = 64
  const g = await open(W, H)
  const { texture, px } = g.source(stripes)
  const at = (b: Uint8Array, x: number, y: number) => b[(y * W + x) * 4] ?? -1
  const same = (b: Uint8Array, x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) if (at(b, x, y) !== at(px, x, y)) return false
    return true
  }

  assert.deepEqual(await g.run(texture, { amount: 0, radius: 30 }), px)
  for (const kind of ['gaussian', 'bokeh', 'directional', 'radial'] as const) {
    const out = await g.run(texture, {
      kind,
      radius: 20,
      shapes: [{ x: 30, y: 16, width: 30, height: 30, amount: 0 }],
    })
    assert.ok(same(out, 30, 60, 16, 46), `${kind}: the window is untouched`)
    assert.ok(!same(out, 0, 20, 0, H), `${kind}: outside it is blurred`)
  }

  // A map: white on the right half blurs it; the left, transparent, stays.
  const map = new Canvas(W, H)
  const m = map.getContext('2d')
  m.fillStyle = '#fff'
  m.fillRect(W / 2, 0, W / 2, H)
  const mapped = await g.run(texture, { radius: 16, map: map as unknown as OffscreenCanvas })
  assert.ok(same(mapped, 0, W / 2 - 1, 0, H), 'map: the left half is untouched')
  assert.ok(!same(mapped, W / 2 + 8, W, 0, H), 'map: the right half is blurred')

  // Depth: the left half in focus at 5, the right at 10, five away and fully blurred.
  const data = new Float32Array(W * H).map((_, i) => (i % W < W / 2 ? 5 : 10))
  data[W - 1] = Number.POSITIVE_INFINITY
  const deep = await g.run(texture, { radius: 16, depth: { data, focus: 5, range: 5 } })
  assert.ok(same(deep, 0, W / 2, 0, H), 'depth: in focus is untouched')
  assert.ok(!same(deep, W / 2 + 8, W, 0, H), 'depth: out of focus is blurred')
  assert.throws(
    () => g.run(texture, { depth: { data: new Float32Array(4), focus: 0, range: 1 } }),
    /depth has 4 values/,
  )

  assert.deepEqual(
    await g.run(texture, { kind: 'bokeh', radius: 9 }),
    await g.run(texture, { kind: 'bokeh', radius: 9 }),
    'the same call gives the same bytes',
  )
  g.done()
})

test("look-blur: a Gaussian's σ is half the radius, from a pixel to tens", async () => {
  const W = 512
  const H = 128
  const g = await open(W, H)
  const { texture } = g.source((x) => (x >= W / 2 ? 255 : 0))
  for (const radius of [1, 6, 20, 50, 120]) {
    const out = await g.run(texture, { radius })
    // The edge's spread, in linear light, along the middle row.
    const row = Array.from({ length: W }, (_, x) => toLinear(out[((H / 2) * W + x) * 4] ?? 0))
    let sum = 0
    let mean = 0
    let spread = 0
    for (let x = 1; x < W; x++) {
      const d = (row[x] ?? 0) - (row[x - 1] ?? 0)
      sum += d
      mean += d * x
    }
    mean /= sum
    for (let x = 1; x < W; x++) spread += ((row[x] ?? 0) - (row[x - 1] ?? 0)) * (x - mean) ** 2
    const sigma = Math.sqrt(spread / sum)
    assert.ok(Math.abs(sigma / (radius / 2) - 1) < 0.05, `radius ${radius}: σ ${sigma.toFixed(2)}`)
  }
  g.done()
})

test('look-blur: bokeh opens a point into a flat disc; blades, directional and radial', async () => {
  const W = 128
  const H = 128
  const g = await open(W, H)
  const c = W / 2
  const point = g.source((x, y) => (Math.abs(x - c) <= 1 && Math.abs(y - c) <= 1 ? 255 : 0))
  const at = (b: Uint8Array, x: number, y: number) => b[(y * W + x) * 4] ?? 0

  const disc = await g.run(point.texture, { kind: 'bokeh', radius: 16 })
  const inner = at(disc, c + 3, c)
  assert.ok(inner > 40, `the disc is lit (${inner})`)
  assert.ok(Math.abs(at(disc, c + 10, c) - inner) < inner * 0.35, 'flat out to most of the radius')
  assert.ok(Math.abs(at(disc, c, c - 10) - inner) < inner * 0.35, 'round: the same upwards')
  assert.ok(at(disc, c + 22, c) < 4 && at(disc, c + 16, c + 16) < 4, 'nothing past the radius')
  const hexagon = await g.run(point.texture, { kind: 'bokeh', radius: 16, blades: 6 })
  assert.notDeepEqual(hexagon, disc, 'blades change the shape')

  const smear = await g.run(point.texture, { kind: 'directional', radius: 16, angle: 0 })
  assert.ok(at(smear, c + 10, c) > 10, 'along the angle')
  assert.ok(at(smear, c, c + 10) < 2, 'not across it')

  // Radial: at the centre the reach is nothing; a point near a corner smears towards it.
  const centred = await g.run(point.texture, { kind: 'radial', radius: 30 })
  assert.equal(at(centred, c, c), 255, 'the centre stays sharp')
  const off = await g.run(point.texture, { kind: 'radial', radius: 30, centre: [8, 8] })
  assert.ok(at(off, c + 8, c + 8) > at(off, c + 8, c - 8), 'away from the centre, not across')
  g.done()
})

test('look-blur: a canvas with transparency comes out premultiplied', async () => {
  const W = 64
  const H = 64
  const g = await open(W, H)
  const canvas = new Canvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(255, 64, 0, 0.5)'
  ctx.fillRect(16, 16, 32, 32)
  const out = await g.run(canvas as unknown as OffscreenCanvas, { radius: 6 })
  assert.equal(out[3], 0, 'transparent stays transparent')
  const i = (32 * W + 32) * 4
  assert.ok(Math.abs((out[i + 3] ?? 0) - 128) <= 2, 'half alpha in the middle')
  for (let k = 0; k < out.length; k += 4)
    assert.ok((out[k] ?? 0) <= (out[k + 3] ?? 0) + 1, 'colour never exceeds alpha')
  g.done()
})
