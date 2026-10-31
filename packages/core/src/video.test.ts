import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { readTexture } from './gpu.ts'
import type { Footage, VideoColour } from './protocol.ts'
import { videoTexture, yuv420p10ToRgba, yuv420pToRgba } from './video.ts'

/** I420 bytes of a frame whose every pixel has one Y, Cb and Cr. */
const flat = (width: number, height: number, y: number, cb: number, cr: number) => {
  const c = Math.ceil(width / 2) * Math.ceil(height / 2)
  return new Uint8Array([
    ...new Array(width * height).fill(y),
    ...new Array(c).fill(cb),
    ...new Array(c).fill(cr),
  ])
}
const pixel = (rgba: Uint8Array, i = 0) => [...rgba.subarray(i * 4, i * 4 + 4)]
const colour = (
  matrix: VideoColour['matrix'],
  range: VideoColour['range'],
  chroma: VideoColour['chroma'] = 'left',
): VideoColour => ({ matrix, range, chroma })

// Worked by hand from the standards' published coefficients, not from the code's Kr and Kb.
test('yuv420pToRgba: the code values the standards give', () => {
  const at = (c: VideoColour, y: number, cb: number, cr: number) =>
    pixel(yuv420pToRgba(flat(2, 2, y, cb, cr), 2, 2, c))
  // BT.709 limited: R = 1.164384 (Y-16) + 1.792741 (Cr-128), G = … - 0.213249 (Cb-128)
  // - 0.532909 (Cr-128), B = … + 2.112402 (Cb-128).
  const hd = colour('bt709', 'limited')
  assert.deepEqual(at(hd, 16, 128, 128), [0, 0, 0, 255], 'black')
  assert.deepEqual(at(hd, 235, 128, 128), [255, 255, 255, 255], 'white')
  assert.deepEqual(at(hd, 126, 128, 128), [128, 128, 128, 255], '110 × 1.164384 = 128.08')
  // 100 % red: R 255.51 clamped, G 0.584, B -0.196.
  assert.deepEqual(at(hd, 63, 102, 240), [255, 1, 0, 255], 'BT.709 red')
  // JFIF (BT.601 full): R = Y + 1.402 (Cr-128), G = Y - 0.344136 (Cb-128) - 0.714136 (Cr-128),
  // B = Y + 1.772 (Cb-128).
  const jpeg = colour('bt601', 'full', 'center')
  assert.deepEqual(at(jpeg, 0, 128, 128), [0, 0, 0, 255])
  assert.deepEqual(at(jpeg, 255, 128, 128), [255, 255, 255, 255])
  assert.deepEqual(at(jpeg, 76, 85, 255), [254, 0, 0, 255], 'R 254.05, G 0.10, B -0.20')
  assert.deepEqual(at(jpeg, 150, 44, 21), [0, 255, 1, 255], 'R -0.01, G 255.32, B 1.15')
  // BT.2020 limited: R = 1.164384 (Y-16) + 1.678674 (Cr-128), G = … - 0.187326 (Cb-128)
  // - 0.650424 (Cr-128), B = … + 2.141772 (Cb-128): 97.81 - 63.79, + 24.72 - 4.12, + 47.12.
  assert.deepEqual(at(colour('bt2020nc', 'limited'), 100, 150, 90), [34, 118, 145, 255])
  // BT.601 limited: R = 1.164384 (Y-16) + 1.596027 (Cr-128): 58.22 + 31.92.
  assert.deepEqual(
    pixel(yuv420pToRgba(flat(1, 1, 66, 128, 148), 1, 1, colour('bt601', 'limited'))).slice(0, 1),
    [90],
  )
})

test('yuv420pToRgba: chroma upsampled from where it is sited', () => {
  // JFIF, Y 128, Cb 128, Cr 128 then 178: R = 128 + 1.402 (Cr-128), B = 128.
  const across = new Uint8Array([128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 178])
  const reds = (rgba: Uint8Array) => [0, 1, 2, 3].map((i) => pixel(rgba, i)[0])
  // Co-sited: Cr 128, 153 (the mean), 178, 178 (the edge clamped).
  assert.deepEqual(
    reds(yuv420pToRgba(across, 4, 2, colour('bt601', 'full', 'left'))),
    [128, 163, 198, 198],
  )
  // Between: 128, 140.5 (¾ 128 + ¼ 178), 165.5, 178.
  assert.deepEqual(
    reds(yuv420pToRgba(across, 4, 2, colour('bt601', 'full', 'center'))),
    [128, 146, 181, 198],
  )
  // Down a 1×4 frame: between rows (left, center) or co-sited (topleft).
  const down = new Uint8Array([128, 128, 128, 128, 128, 128, 128, 178])
  assert.deepEqual(
    reds(yuv420pToRgba(down, 1, 4, colour('bt601', 'full', 'left'))),
    [128, 146, 181, 198],
  )
  assert.deepEqual(
    reds(yuv420pToRgba(down, 1, 4, colour('bt601', 'full', 'topleft'))),
    [128, 163, 198, 198],
  )
  for (const c of ['left', 'center', 'topleft'] as const)
    assert.ok(
      [0, 1, 2, 3].every(
        (i) => pixel(yuv420pToRgba(down, 1, 4, colour('bt601', 'full', c)), i)[2] === 128,
      ),
    )
})

/** I420 at 10 bits (ADR 0031) of a frame whose every pixel has one Y, Cb and Cr. */
const flat10 = (width: number, height: number, y: number, cb: number, cr: number) =>
  Uint16Array.from(flat(width, height, 0, 0, 0), (_, i) =>
    i < width * height
      ? y
      : i < width * height + Math.ceil(width / 2) * Math.ceil(height / 2)
        ? cb
        : cr,
  )
/** A half float's value. */
const half = (h: number) => {
  const e = (h >> 10) & 31
  const m = h & 1023
  const v = e === 0 ? m / 2 ** 24 : (1 + m / 1024) * 2 ** (e - 15)
  return h & 0x8000 ? -v : v
}
/** Pixel `i` of half-float RGBA, in 1024ths. */
const pixel10 = (rgba: Uint16Array, i = 0) =>
  [...rgba.subarray(i * 4, i * 4 + 4)].map((h) => half(h) * 1024)

// Worked by hand from the standards: 10-bit limited is Y 64–940 and C 64–960 (centre 512), full
// 0–1023; the output is k / 1024 with k rounded half up and clamped to −2048…2047.
test('yuv420p10ToRgba: code values in 1024ths, superwhites and negatives kept', () => {
  const at = (c: VideoColour, y: number, cb: number, cr: number) =>
    pixel10(yuv420p10ToRgba(flat10(2, 2, y, cb, cr), 2, 2, c))
  const hd = colour('bt709', 'limited')
  assert.deepEqual(at(hd, 64, 512, 512), [0, 0, 0, 1024], 'black')
  assert.deepEqual(at(hd, 940, 512, 512), [1024, 1024, 1024, 1024], 'white')
  assert.deepEqual(at(hd, 502, 512, 512), [512, 512, 512, 1024], '438 / 876 = ½')
  // Superwhite: 955 / 876 × 1024 = 1116.35.
  assert.deepEqual(at(hd, 1019, 512, 512), [1116, 1116, 1116, 1024], 'past 1, kept')
  // BT.709: R = (Y-64)/876 + 1.5748 (Cr-512)/896: Cr 64 is -0.7874, -806.3 in 1024ths.
  assert.deepEqual(at(hd, 64, 512, 64).slice(0, 1), [-806], 'below 0, kept')
  // The corners pass ±2 and clamp: B = 959/876 + 1.8814 × 511/896 = 2.168 (BT.2020).
  assert.deepEqual(at(colour('bt2020nc', 'limited'), 1023, 1023, 512).slice(2, 3), [2047])
  // Full range: Y / 1023 and (C-512) / 1023. JFIF: R = Y + 1.402 (Cr-512) / 1023 × 1024.
  const jpeg = colour('bt601', 'full', 'center')
  assert.deepEqual(at(jpeg, 0, 512, 512), [0, 0, 0, 1024])
  assert.deepEqual(at(jpeg, 1023, 512, 512), [1024, 1024, 1024, 1024])
  // 300 / 1023 × 1024 = 300.29, + 1.402 × 100 / 1023 × 1024 = 140.33: 440.6.
  assert.deepEqual(at(jpeg, 300, 512, 612).slice(0, 1), [441])
})

test('yuv420p10ToRgba: chroma upsampled as yuv420pToRgba sites it', () => {
  // The 8-bit test's frames shifted up two bits, in JFIF: R = Y + 1.402 (Cr-512) / 1023 × 1024.
  const across = Uint16Array.from(
    [128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 178],
    (v) => v << 2,
  )
  const reds = (rgba: Uint16Array) => [0, 1, 2, 3].map((i) => pixel10(rgba, i)[0])
  // Y 512 is 512.5; Cr 612 (the mean) adds 140.33, 712 280.66.
  assert.deepEqual(
    reds(yuv420p10ToRgba(across, 4, 2, colour('bt601', 'full', 'left'))),
    [513, 653, 793, 793],
  )
  // Between: Cr 562 (¾ 512 + ¼ 712) adds 70.16, 662 210.49.
  assert.deepEqual(
    reds(yuv420p10ToRgba(across, 4, 2, colour('bt601', 'full', 'center'))),
    [513, 583, 723, 793],
  )
})

/**
 * videoTexture on Dawn (from apps/cli/fixtures/particles) against the reference, byte for byte.
 * Needs a GPU: without one this fails, it does not skip.
 */
const dawn = createRequire(
  join(import.meta.dirname, '../../../apps/cli/fixtures/particles/package.json'),
)('webgpu') as { create(flags: string[]): GPU; globals: object }
Object.assign(globalThis, dawn.globals)
// Dawn's instance must outlive the device (dropped, it crashes readback): held on globalThis.
const held = globalThis as { dawn?: GPU }
held.dawn = dawn.create([])
const device = await ((await held.dawn.requestAdapter()) as GPUAdapter).requestDevice()

/** Bytes from the code extremes and hard edges: a seeded mix of 0, 16, 128, 235, 240, 255 and noise. */
const fixture = (width: number, height: number, seed: number) => {
  const n = width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)
  const codes = [0, 16, 128, 235, 240, 255]
  let s = seed
  return Uint8Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) >>> 0
    return s % 3 === 0 ? (s >>> 8) & 255 : (codes[(s >>> 8) % codes.length] as number)
  })
}

test('videoTexture gives the reference bytes on the GPU: every matrix, range and siting, odd sizes', async () => {
  for (const [width, height] of [
    [16, 8],
    [7, 5],
    [33, 1],
  ] as const)
    for (const matrix of ['bt709', 'bt601', 'bt2020nc'] as const)
      for (const range of ['limited', 'full'] as const)
        for (const chroma of ['left', 'center', 'topleft'] as const) {
          const c = { matrix, range, chroma }
          const bytes = fixture(width, height, width * 7 + height)
          const clip = {
            width,
            height,
            fps: 1,
            frames: 1,
            bits: 8,
            colour: c,
            frame: async (_: number, o?: { format?: string }) => {
              assert.equal(o?.format, 'yuv420p')
              return bytes
            },
            close: async () => {},
          } as Footage
          const v = videoTexture(device, clip)
          try {
            const got = await readTexture(device, await v.frame(0))
            const want = yuv420pToRgba(bytes, width, height, c)
            assert.ok(
              Buffer.from(got).equals(Buffer.from(want)),
              `${width}×${height} ${matrix} ${range} ${chroma}`,
            )
          } finally {
            v.destroy()
          }
        }
})

/** 10-bit samples from the code extremes and hard edges: 0, 64, 512, 940, 960, 1023 and noise. */
const fixture10 = (width: number, height: number, seed: number) => {
  const n = width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)
  const codes = [0, 64, 512, 940, 960, 1023]
  let s = seed
  return Uint16Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) >>> 0
    return s % 3 === 0 ? (s >>> 8) & 1023 : (codes[(s >>> 8) % codes.length] as number)
  })
}

test('videoTexture at 10 bits gives the reference half floats on the GPU: every matrix, range and siting, odd sizes', async () => {
  for (const [width, height] of [
    [16, 8],
    [7, 5],
    [33, 1],
  ] as const)
    for (const matrix of ['bt709', 'bt601', 'bt2020nc'] as const)
      for (const range of ['limited', 'full'] as const)
        for (const chroma of ['left', 'center', 'topleft'] as const) {
          const c = { matrix, range, chroma }
          const samples = fixture10(width, height, width * 7 + height)
          const clip = {
            width,
            height,
            fps: 1,
            frames: 1,
            bits: 10,
            colour: c,
            frame: async (_: number, o?: { format?: string }) => {
              assert.equal(o?.format, 'yuv420p10')
              return samples
            },
            close: async () => {},
          } as Footage
          const v = videoTexture(device, clip, { bits: 10 })
          try {
            const got = await readTexture(device, await v.frame(0), 8)
            const want = yuv420p10ToRgba(samples, width, height, c)
            assert.ok(
              Buffer.from(got).equals(Buffer.from(want.buffer)),
              `${width}×${height} ${matrix} ${range} ${chroma}`,
            )
          } finally {
            v.destroy()
          }
        }
})
