import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { gpuCompositor, yuvFits } from './compositor.ts'
import { matte, over, type RgbaLayer, straight } from './over.ts'

/**
 * The GPU compositor against `over` (the CPU rules), on Dawn from apps/cli/fixtures/particles.
 * Needs a GPU: without one this fails, it does not skip.
 */
const dawn = createRequire(
  join(import.meta.dirname, '../../../apps/cli/fixtures/particles/package.json'),
)('webgpu') as { create(flags: string[]): GPU; globals: object }
Object.assign(globalThis, dawn.globals)
// Dawn's instance must outlive the device (dropped, it crashes readback): held on globalThis.
const held = globalThis as { dawn?: GPU }
held.dawn = dawn.create([])
const device = await (await held.dawn.requestAdapter())!.requestDevice()

const W = 16
const H = 8
/** A layer of one colour everywhere, or `right` on the right half. */
const fill = (left: number[], right = left) => {
  const data = new Uint8Array(W * H * 4)
  for (let p = 0; p < W * H; p++) data.set(p % W < W / 2 ? left : right, p * 4)
  return data
}
const near = (
  got: Uint8Array,
  want: Uint8Array | Uint8ClampedArray,
  tolerance: number,
  what: string,
) => {
  let worst = 0
  for (let i = 0; i < want.length; i++)
    worst = Math.max(worst, Math.abs((got[i] ?? -999) - (want[i] as number)))
  assert.ok(worst <= tolerance, `${what}: off by ${worst} (±${tolerance})`)
}

const stacks: { name: string; layers: RgbaLayer[] }[] = [
  {
    // The pixel contract's fixture: straight (200,120,40,128), a premultiplied veil on the right.
    name: 'straight + premultiplied veil',
    layers: [
      { data: fill([200, 120, 40, 128]), alpha: 'straight' },
      { data: fill([0, 0, 0, 0], [50, 50, 50, 128]), alpha: 'premultiplied' },
    ],
  },
  {
    name: 'opaque under straight',
    layers: [
      { data: fill([10, 200, 90, 7]), alpha: 'opaque' },
      { data: fill([255, 0, 0, 64], [0, 0, 255, 255]), alpha: 'straight' },
    ],
  },
  {
    name: 'depth: the nearer layer hides the later one, softly',
    layers: [
      {
        data: fill([200, 0, 0, 255]),
        alpha: 'opaque',
        depth: { data: new Float32Array(W * H).fill(5) },
      },
      {
        data: fill([0, 200, 0, 255]),
        alpha: 'straight',
        depth: {
          data: new Float32Array(W * H).map((_, p) => (p % W < W / 2 ? 9 : Infinity)),
          soft: 8,
        },
      },
    ],
  },
]

for (const { name, layers } of stacks) {
  test(`gpu rgba matches over: ${name}`, async () => {
    const c = gpuCompositor(device, W, H)
    try {
      const gpu = await c.composite(
        layers.map((l) => ({ color: l.data, alpha: l.alpha, depth: l.depth })),
        'rgba',
      )
      const cpu = straight({ alpha: 'premultiplied', data: over(layers, W, H) })
      // The CPU rounds to 8 bits after every layer; the GPU keeps floats until the end.
      near(gpu, cpu, 2, name)
    } finally {
      c.destroy()
    }
  })
}

/** Y'CbCr BT.709 limited from matted sRGB code values, per pixel (no subsampling). */
const ycc = (r: number, g: number, b: number): [number, number, number] => {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  return [
    Math.round(16 + 219 * (0.2126 * R + 0.7152 * G + 0.0722 * B)),
    Math.round(128 + 224 * (-0.114572 * R - 0.385428 * G + 0.5 * B)),
    Math.round(128 + 224 * (0.5 * R - 0.454153 * G - 0.045847 * B)),
  ]
}

test('gpu yuv420p is the matted frame in BT.709 limited range, planes Y, Cb, Cr', async () => {
  assert.ok(yuvFits(W, H) && !yuvFits(1366, 768) && !yuvFits(W, 7))
  const { layers } = stacks[0]!
  const c = gpuCompositor(device, W, H)
  try {
    const yuv = await c.composite(
      layers.map((l) => ({ color: l.data, alpha: l.alpha })),
      'yuv420p',
    )
    assert.equal(yuv.length, (W * H * 3) / 2)
    const m = matte(straight({ alpha: 'premultiplied', data: over(layers, W, H) }))
    const px = (x: number, y: number) =>
      [...m.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)] as [number, number, number]
    // Flat areas, away from the left/right seam.
    for (const x of [2, 13]) {
      const [y, u, v] = ycc(...px(x, 3))
      assert.ok(Math.abs((yuv[3 * W + x] as number) - y) <= 1, `Y at ${x}`)
      const ci = (3 >> 1) * (W / 2) + (x >> 1)
      assert.ok(Math.abs((yuv[W * H + ci] as number) - u) <= 1, `Cb at ${x}`)
      assert.ok(Math.abs((yuv[W * H + (W * H) / 4 + ci] as number) - v) <= 1, `Cr at ${x}`)
    }
  } finally {
    c.destroy()
  }
})

test('a GPUTexture layer composites with no upload; a wrong size or usage is refused', async () => {
  const texture = device.createTexture({
    size: [W, H],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture({ texture }, fill([30, 60, 90, 255]), { bytesPerRow: W * 4 }, [W, H])
  const c = gpuCompositor(device, W, H)
  try {
    const out = await c.composite([{ color: texture, alpha: 'opaque' }], 'rgba')
    near(out, fill([30, 60, 90, 255]), 0, 'texture')
    const small = device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    })
    await assert.rejects(
      c.composite([{ color: small, alpha: 'opaque' }], 'rgba'),
      /4x4; the frame is 16x8/,
    )
    const hidden = device.createTexture({
      size: [W, H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST,
    })
    await assert.rejects(
      c.composite([{ color: hidden, alpha: 'opaque' }], 'rgba'),
      /TEXTURE_BINDING/,
    )
  } finally {
    c.destroy()
    texture.destroy()
  }
})

test('rgba64 keeps what a float layer has between 8-bit codes, and agrees with rgba', async () => {
  // A ramp in steps of 1/1024 (10-bit): 8-bit rounds four steps into one code, 16-bit keeps them.
  const texture = device.createTexture({
    size: [W, H],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const ramp = new Float32Array(W * H * 4)
  for (let p = 0; p < W * H; p++) ramp.set([0.5 + (p % W) / 1024, 0.25, 0.75, 1], p * 4)
  device.queue.writeTexture({ texture }, ramp, { bytesPerRow: W * 16 }, [W, H])
  const c = gpuCompositor(device, W, H)
  try {
    const deep = await c.composite([{ color: texture, alpha: 'opaque' }], 'rgba64')
    const bytes = await c.composite([{ color: texture, alpha: 'opaque' }], 'rgba')
    assert.equal(deep.length, W * H * 8)
    const words = new Uint16Array(deep.buffer, deep.byteOffset, W * H * 4)
    const reds = new Set<number>()
    for (let x = 0; x < W; x++) {
      const r = words[x * 4] as number
      reds.add(r)
      // Half-float precision near 0.5 is 2^-11: well inside one 10-bit step.
      assert.ok(Math.abs(r / 65535 - (0.5 + x / 1024)) < 1 / 2048, `red at ${x}: ${r}`)
      assert.ok(Math.abs(r / 257 - (bytes[x * 4] as number)) <= 1, `16-bit and 8-bit at ${x}`)
    }
    assert.equal(reds.size, W, 'every 10-bit step is its own 16-bit value')
    assert.equal(words[3], 65535, 'opaque')
  } finally {
    c.destroy()
    texture.destroy()
  }
})
