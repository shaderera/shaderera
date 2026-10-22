import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixture } from '../../../apps/cli/src/node/fixtures/hdr/src/composition.ts'
import type { GpuLayer } from './compositor.ts'
import {
  CODE_LIGHT,
  lightReference,
  p010Reference,
  peakCode,
  pqEncode,
  type ReferenceLayer,
  rgb10Reference,
} from './hdr.ts'
import { hdrCompositor, p010Fits } from './hdr-compositor.ts'
import type { Hdr10 } from './protocol.ts'

/**
 * The HDR compositor against its float64 reference (docs/adr/0023, decision 4), on Dawn from
 * apps/cli/fixtures/particles. Needs a GPU: without one this fails, it does not skip.
 */
const dawn = createRequire(
  join(import.meta.dirname, '../../../apps/cli/fixtures/particles/package.json'),
)('webgpu') as { create(flags: string[]): GPU; globals: object }
Object.assign(globalThis, dawn.globals)
const held = globalThis as { dawn?: GPU }
held.dawn ??= dawn.create([])
const device = await (await held.dawn.requestAdapter())!.requestDevice()

const W = 1024
const H = 64
const FRAME = 7
const MASTERING = { min: 0.0001, primaries: 'bt2020' } as const
const HDR: Hdr10 = { mastering: { ...MASTERING, peak: 10000 }, dither: 'tpdf' }
const graded = (peak: number, dither: Hdr10['dither']): Hdr10 => ({
  mastering: { ...MASTERING, peak },
  dither,
})

const floatTexture = (data: Float32Array, width = W, height = H) => {
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture },
    data as Float32Array<ArrayBuffer>,
    { bytesPerRow: width * 16 },
    [width, height],
  )
  return texture
}

/** The fixture's layers, for the reference and for the GPU. */
const { pq, linear, graphics } = fixture(W, H)
const PQ_LIGHT = { transfer: 'pq', primaries: 'bt2020' } as const
const LINEAR_LIGHT = { transfer: 'linear', primaries: 'bt2020' } as const
const reference: ReferenceLayer[] = [
  { data: pq, alpha: 'straight', light: PQ_LIGHT },
  { data: linear, alpha: 'premultiplied', light: LINEAR_LIGHT },
  { data: graphics, alpha: 'straight' },
]
const textures = { pq: floatTexture(pq), linear: floatTexture(linear) }
const gpuLayers = (): GpuLayer[] => [
  { color: textures.pq, alpha: 'straight', light: PQ_LIGHT },
  { color: textures.linear, alpha: 'premultiplied', light: LINEAR_LIGHT },
  { color: graphics, alpha: 'straight' },
]

/** Compares 10-bit samples: the worst difference, how many are off by one, and the top codes. */
const compare = (got: ArrayLike<number>, want: ArrayLike<number>) => {
  assert.equal(got.length, want.length)
  let worst = 0
  let offByOne = 0
  let topGot = 0
  let topWant = 0
  for (let i = 0; i < want.length; i++) {
    const d = Math.abs((got[i] as number) - (want[i] as number))
    worst = Math.max(worst, d)
    if (d === 1) offByOne++
    topGot = Math.max(topGot, got[i] as number)
    topWant = Math.max(topWant, want[i] as number)
  }
  return { worst, share: offByOne / want.length, topGot, topWant }
}
const channels = (codes: Uint32Array) =>
  Array.from(codes).flatMap((w) => [w & 1023, (w >>> 10) & 1023, (w >>> 20) & 1023])
const words = (bytes: Uint8Array) =>
  new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
const p010Codes = (p010: Uint16Array) => Array.from(p010, (v) => v >> 6)

/** The ADR's pass: none off by more than one code, under 0.01% off by one, the top code equal. */
const passes = (what: string, c: ReturnType<typeof compare>) => {
  assert.ok(c.worst <= 1, `${what}: off by ${c.worst}`)
  assert.ok(c.share < 1e-4, `${what}: ${(c.share * 100).toFixed(4)}% off by one`)
  assert.equal(c.topGot, c.topWant, `${what}: top code`)
}

test('P010 and the light levels from the GPU codes match the float64 reference', async (t) => {
  assert.ok(p010Fits(W, H) && !p010Fits(W, 63))
  const c = hdrCompositor(device, W, H, HDR)
  try {
    const rgb10 = await c.composite(gpuLayers(), 'rgb10', FRAME)
    const p010 = await c.composite(gpuLayers(), 'p010', FRAME)
    assert.equal(p010.bytes.length, W * H * 3)
    const codes = words(rgb10.bytes)
    const got = new Uint16Array(p010.bytes.buffer, p010.bytes.byteOffset, (W * H * 3) / 2)
    const p = compare(p010Codes(got), p010Codes(p010Reference(codes, W, H)))
    passes('P010', p)
    // The bottom six bits of every P010 word are zero.
    assert.ok(got.every((v) => (v & 63) === 0))
    const want = lightReference(codes)
    assert.deepEqual(p010.light, rgb10.light)
    assert.equal(p010.light.maxCll, want.maxCll)
    const fall = Math.abs(p010.light.maxFall - want.maxFall) / want.maxFall
    assert.ok(fall < 1e-4, `MaxFALL ${p010.light.maxFall} vs ${want.maxFall}`)
    t.diagnostic(
      `P010 vs float64: worst ${p.worst}, off by one ${(p.share * 100).toFixed(5)}%, top ${p.topGot}/${p.topWant}; MaxCLL ${p010.light.maxCll} vs ${want.maxCll}; MaxFALL ${p010.light.maxFall} vs ${want.maxFall} (relative ${fall.toExponential(2)})`,
    )
  } finally {
    c.destroy()
  }
})

test('the composite to 10-bit codes matches the float64 reference of the layers', async (t) => {
  const c = hdrCompositor(device, W, H, HDR)
  try {
    const { bytes, light } = await c.composite(gpuLayers(), 'rgb10', FRAME)
    const want = rgb10Reference(reference, W, H, HDR, FRAME)
    const r = compare(channels(words(bytes)), channels(want))
    // f32 against float64 through PQ's curve: a sample within f32's rounding of a code's edge
    // lands on either side. Measured 0.12% here; the edge, not the arithmetic, is what moves.
    assert.ok(r.worst <= 1, `R′G′B′: off by ${r.worst}`)
    assert.ok(r.share < 0.005, `R′G′B′: ${(r.share * 100).toFixed(4)}% off by one`)
    assert.equal(r.topGot, r.topWant)
    const levels = lightReference(want)
    const fall = Math.abs(light.maxFall - levels.maxFall) / levels.maxFall
    assert.equal(light.maxCll, levels.maxCll)
    assert.ok(fall < 1e-4)
    t.diagnostic(
      `R′G′B′ codes vs float64: worst ${r.worst}, off by one ${(r.share * 100).toFixed(5)}%, top ${r.topGot}/${r.topWant}; MaxCLL ${light.maxCll} vs ${levels.maxCll}; MaxFALL ${light.maxFall} vs ${levels.maxFall} (relative ${fall.toExponential(2)})`,
    )
  } finally {
    c.destroy()
  }
})

test('undithered, the ramp is every code and Graphics White is where BT.2408 puts it', async () => {
  const c = hdrCompositor(device, W, H, { ...HDR, dither: 'none' })
  try {
    const reds = channels(words((await c.composite(gpuLayers(), 'rgb10', FRAME)).bytes)).filter(
      (_, i) => i % 3 === 0,
    )
    assert.deepEqual(
      reds.slice(0, W),
      Array.from({ length: W }, (_, x) => x),
    )
    // 203 cd/m² is 58% PQ (BT.2408): code 594 of 1023 full range, 572 in narrow-range Y'.
    assert.equal(reds[32 * W], Math.round(pqEncode(203 / 10000) * 1023))
    assert.equal(reds[32 * W], 594)
  } finally {
    c.destroy()
  }
})

const flat = (rgb: number[], width = 16, height = 8) => {
  const data = new Float32Array(width * height * 4)
  for (let p = 0; p < width * height; p++) data.set([...rgb, 1], p * 4)
  return data
}
const linearLayer = (rgb: number[]): GpuLayer => ({
  color: floatTexture(flat(rgb), 16, 8),
  alpha: 'opaque',
  light: { transfer: 'linear', primaries: 'bt2020' },
})

test('the dither is seeded by the frame, never lifts black, and never steps past the peak', async () => {
  const peak = 1000
  const c = hdrCompositor(device, 16, 8, graded(peak, 'tpdf'))
  const plain = hdrCompositor(device, 16, 8, graded(peak, 'none'))
  try {
    const black = await c.composite([linearLayer([0, 0, 0])], 'rgb10', 3)
    assert.ok(words(black.bytes).every((w) => w === 0))
    assert.deepEqual(black.light, { maxCll: 0, maxFall: 0 })
    const grey = [0.3, 0.3, 0.3]
    const a = words((await c.composite([linearLayer(grey)], 'rgb10', 3)).bytes)
    const b = words((await c.composite([linearLayer(grey)], 'rgb10', 4)).bytes)
    const again = words((await c.composite([linearLayer(grey)], 'rgb10', 3)).bytes)
    assert.deepEqual(again, a)
    assert.notDeepEqual(b, a)
    const undithered = words((await plain.composite([linearLayer(grey)], 'rgb10', 3)).bytes)
    assert.equal(new Set(undithered).size, 1)
    // Light at the peak: dithered, never a code above the peak's.
    const top = peakCode(peak)
    const atPeak = await c.composite(
      [linearLayer([peak / 203, peak / 203, peak / 203])],
      'rgb10',
      3,
    )
    assert.ok(channels(words(atPeak.bytes)).every((code) => code <= top))
    assert.ok((CODE_LIGHT[top] as number) <= peak && (CODE_LIGHT[top + 1] as number) > peak)
  } finally {
    c.destroy()
    plain.destroy()
  }
})

test('a frame above the mastering peak is an error naming the frame and its light, never clipped', async () => {
  const c = hdrCompositor(device, 16, 8, graded(1000, 'none'))
  try {
    await assert.rejects(c.composite([linearLayer([1100 / 203, 0, 0])], 'p010', 12), {
      message:
        "Frame 12 reaches 1102 cd/m², above the mastering display's peak of 1000 cd/m² (hdr10.mastering.peak). The engine never clips light: the film maps its own light down to the display it was graded on, or declares the display it was.",
    })
    await assert.rejects(
      c.composite([linearLayer([0, 20000 / 203, 0])], 'rgb10', 5),
      /^Error: Frame 5 passes 10000 cd\/m², PQ's peak, in 128 pixels/,
    )
  } finally {
    c.destroy()
  }
})
