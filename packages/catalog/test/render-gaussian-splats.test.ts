// render-gaussian-splats, headless on Dawn: a five-splat scene written as .splat and as .ply bytes, both
// decoded alike, rendered at 64×64 and read back. Checked: colours at the projected centres, the
// nearer splat on top, a transparent background, a splat behind the camera left out, the
// back-to-front order with ties in index order, and byte-identical pixels across renders.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTexture } from '@shaderera/core/gpu'
import { create, globals } from 'webgpu'
import {
  createSplatRenderer,
  loadSplats,
  parsePly,
  parseSplat,
  parseSplats,
  type Splats,
} from '../render-gaussian-splats/src/render/splats.ts'

Object.assign(globalThis, globals)

type V3 = [number, number, number]
const SH_C0 = 0.28209479177387814
const W = 64
const H = 64

// 0 red, 1 green (nearer, in front of 2), 2 blue (far, long, turned 30° about z), 3 magenta and
// huge but behind the camera, 4 white at the same depth as red.
const half = (15 * Math.PI) / 180
const scene = [
  { p: [-0.6, 0, 0], s: [0.15, 0.15, 0.15], c: [255, 0, 0, 250], q: [1, 0, 0, 0] },
  { p: [0.4, 0, 1], s: [0.25, 0.25, 0.25], c: [0, 255, 0, 250], q: [1, 0, 0, 0] },
  {
    p: [0.6, 0, -1],
    s: [0.8, 0.1, 0.1],
    c: [0, 0, 255, 250],
    q: [Math.cos(half), 0, 0, Math.sin(half)],
  },
  { p: [0, 0, 7], s: [2, 2, 2], c: [255, 0, 255, 250], q: [1, 0, 0, 0] },
  { p: [0, 0.6, 0], s: [0.1, 0.1, 0.1], c: [255, 255, 255, 250], q: [1, 0, 0, 0] },
]

const encodeSplat = () => {
  const out = new Uint8Array(scene.length * 32)
  const v = new DataView(out.buffer)
  scene.forEach((s, i) => {
    const o = i * 32
    for (let k = 0; k < 3; k++) {
      v.setFloat32(o + k * 4, s.p[k] ?? 0, true)
      v.setFloat32(o + 12 + k * 4, s.s[k] ?? 0, true)
    }
    for (let k = 0; k < 4; k++) {
      out[o + 24 + k] = s.c[k] ?? 0
      out[o + 28 + k] = Math.max(0, Math.min(255, Math.round((s.q[k] ?? 0) * 128 + 128)))
    }
  })
  return out
}

// A 3DGS training .ply: normals and some f_rest the loader skips, everything as stored (log
// scales, logit opacity, SH DC colour, an unnormalised quaternion).
const encodePly = () => {
  const props = [
    'x y z nx ny nz f_dc_0 f_dc_1 f_dc_2 f_rest_0 f_rest_1 f_rest_2 opacity',
    'scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3',
  ]
    .join(' ')
    .split(' ')
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${scene.length}\n${props
    .map((p) => `property float ${p}`)
    .join('\n')}\nend_header\n`
  const head = new TextEncoder().encode(header)
  const body = new Float32Array(scene.length * props.length)
  scene.forEach((s, i) => {
    const a = (s.c[3] ?? 0) / 255
    const row = [
      ...s.p,
      0,
      0,
      1,
      ...s.c.slice(0, 3).map((c) => (c / 255 - 0.5) / SH_C0),
      0.3,
      -0.2,
      0.1,
      Math.log(a / (1 - a)),
      ...s.s.map(Math.log),
      ...s.q.map((q) => q * 2),
    ]
    body.set(row, i * props.length)
  })
  const out = new Uint8Array(head.length + body.byteLength)
  out.set(head)
  out.set(new Uint8Array(body.buffer), head.length)
  return out
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a)
  return [a[0] / l, a[1] / l, a[2] / l]
}
// As camera-keyframes: world to camera, the camera looks down −z; column-major.
const lookAt = (eye: V3, target: V3, up: V3 = [0, 1, 0]) => {
  const z = norm(sub(eye, target))
  const x = norm(cross(up, z))
  const y = cross(z, x)
  // biome-ignore format: a matrix reads as columns
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]
}
// WebGPU clip space, z 0 at near and 1 at far.
const perspective = (fov: number, aspect: number, n = 0.1, f = 100) => {
  const k = 1 / Math.tan((fov * Math.PI) / 360)
  const r = 1 / (n - f)
  // biome-ignore format: a matrix reads as columns
  return [
    k / aspect, 0, 0, 0,
    0, k, 0, 0,
    0, 0, f * r, -1,
    0, 0, n * f * r, 0,
  ]
}

const halfToFloat = (h: number) => {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

const near = (a: Float32Array, b: Float32Array, tol: number, what: string) => {
  assert.equal(a.length, b.length, what)
  for (let i = 0; i < a.length; i++)
    assert.ok(Math.abs((a[i] ?? 0) - (b[i] ?? 0)) <= tol, `${what}[${i}]: ${a[i]} vs ${b[i]}`)
}

test('render-gaussian-splats: .splat and .ply decode to the same splats', async () => {
  const fromSplat = parseSplat(encodeSplat())
  const fromPly = parsePly(encodePly())
  assert.equal(fromSplat.count, 5)
  assert.equal(fromPly.count, 5)
  near(fromSplat.positions, fromPly.positions, 0, 'positions')
  near(fromSplat.scales, fromPly.scales, 1e-6, 'scales')
  near(fromSplat.colors, fromPly.colors, 1e-5, 'colors')
  near(fromSplat.rotations, fromPly.rotations, 0.01, 'rotations')
  assert.ok(Math.abs((fromPly.colors[3] ?? 0) - 250 / 255) < 1e-6, 'opacity through the sigmoid')
  assert.equal(parseSplats(encodePly()).count, 5)
  assert.equal(parseSplats(encodeSplat()).count, 5)
  const host = { io: { read: async () => encodePly() } }
  assert.equal((await loadSplats(host, 'scene.ply')).count, 5)
  assert.throws(() => parseSplat(new Uint8Array(33)))
})

test('render-gaussian-splats: EWA splats render back to front, deterministic, nothing behind the camera', async () => {
  const gpu = create([])
  const adapter = await gpu.requestAdapter()
  assert.ok(adapter)
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (e) =>
    errors.push((e as GPUUncapturedErrorEvent).error.message),
  )
  // A fresh staging buffer per read: reusing one across reads crashed Dawn now and then.
  const readBytes = (texture: GPUTexture, bytesPerTexel: number) =>
    readTexture(device, texture, bytesPerTexel)

  const splats: Splats = parseSplat(encodeSplat())
  const renderer = createSplatRenderer(device, { width: W, height: H })
  renderer.upload(splats)
  const proj = perspective(45, W / H)
  const front = lookAt([0, 0, 5], [0, 0, 0])
  const other = lookAt([3, 1, 5], [0, 0, 0])

  const first = await readBytes(renderer.render(front, proj), 8)
  assert.deepEqual(Array.from(renderer.order), [2, 0, 4, 1], 'far to near, the tie in index order')
  const between = await readBytes(renderer.render(other, proj), 8)
  assert.ok(!Buffer.from(first).equals(Buffer.from(between)), 'another camera, another picture')
  const again = await readBytes(renderer.render(front, proj), 8)
  assert.ok(Buffer.from(first).equals(Buffer.from(again)), 'the same camera, the same bytes')
  const twice = await readBytes(renderer.render(front, proj), 8)
  assert.ok(Buffer.from(first).equals(Buffer.from(twice)), 'rendered twice, the same bytes')

  const halves = new Uint16Array(first.buffer, first.byteOffset, first.byteLength / 2)
  const px = (x: number, y: number) =>
    [0, 1, 2, 3].map((k) => halfToFloat(halves[(y * W + x) * 4 + k] ?? 0))
  // Projected centres: x = 32 + 32 · k·x/z, k = 1/tan(22.5°); rows run down.
  const k = 1 / Math.tan(Math.PI / 8)
  const col = (x: number, depth: number) => Math.floor(32 + (32 * k * x) / depth)
  const red = px(col(-0.6, 5), 32)
  assert.ok((red[0] ?? 0) > 0.8 && (red[1] ?? 1) < 0.1 && (red[2] ?? 1) < 0.1, `red ${red}`)
  const white = px(32, Math.floor(32 - (32 * k * 0.6) / 5))
  assert.ok(
    white.every((v) => v > 0.8),
    `white ${white}`,
  )
  const g = px(col(0.4, 4), 32)
  assert.ok((g[1] ?? 0) > 0.8 && (g[2] ?? 1) < 0.1, `the nearer green over blue ${g}`)
  // Along the blue splat's long axis, 30° up from +x, past the green one.
  const bx = 32 + (32 * k * 0.6) / 6
  const b = px(
    Math.floor(bx + 12 * Math.cos(Math.PI / 6)),
    Math.floor(32 - 12 * Math.sin(Math.PI / 6)),
  )
  assert.ok((b[2] ?? 0) > 0.3 && (b[2] ?? 0) > 3 * (b[1] ?? 0), `blue along its axis ${b}`)
  const across = px(
    Math.floor(bx + 12 * Math.cos(Math.PI / 6)),
    Math.floor(32 + 12 * Math.sin(Math.PI / 6)),
  )
  assert.ok((across[2] ?? 1) < 0.05, `the blue splat is turned, not mirrored ${across}`)
  for (const [x, y] of [
    [0, 0],
    [63, 0],
    [0, 63],
    [63, 63],
    [32, 56],
  ] as const)
    assert.deepEqual(px(x, y), [0, 0, 0, 0], `transparent background at ${x},${y}`)
  for (let i = 0; i < W * H; i++) {
    const [r, gg, bb, a] = [0, 1, 2, 3].map((c) => halfToFloat(halves[i * 4 + c] ?? 0))
    assert.ok((r ?? 0) <= (a ?? 0) + 1e-3 && (bb ?? 0) <= (a ?? 0) + 1e-3, 'premultiplied')
    assert.ok(!((r ?? 0) > 0.3 && (bb ?? 0) > 0.3 && (gg ?? 0) < 0.1), 'no magenta from behind')
  }

  // Turned round, the camera sees the magenta splat and nothing else.
  renderer.render(lookAt([0, 0, 5], [0, 0, 10]), proj)
  assert.deepEqual(Array.from(renderer.order), [3])
  const back = await readBytes(renderer.render(lookAt([0, 0, 5], [0, 0, 10]), proj), 8)
  const bh = new Uint16Array(back.buffer, back.byteOffset, back.byteLength / 2)
  const m = [0, 1, 2, 3].map((c) => halfToFloat(bh[(32 * W + 32) * 4 + c] ?? 0))
  assert.ok((m[0] ?? 0) > 0.8 && (m[2] ?? 0) > 0.8 && (m[1] ?? 1) < 0.1, `magenta ${m}`)

  // rgba8unorm: the same picture in bytes.
  const small = createSplatRenderer(device, { width: W, height: H, format: 'rgba8unorm' })
  small.upload(parsePly(encodePly()))
  const bytes = await readBytes(small.render(front, proj), 4)
  const at = (x: number, y: number) =>
    Array.from(bytes.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))
  assert.ok((at(col(0.4, 4), 32)[1] ?? 0) > 200, 'green on top in rgba8unorm')
  assert.deepEqual(at(0, 0), [0, 0, 0, 0])

  // No splats: a clear frame.
  small.upload(parseSplat(new Uint8Array(0)))
  const empty = await readBytes(small.render(front, proj), 4)
  assert.ok(empty.every((v) => v === 0))

  assert.deepEqual(errors, [])
  renderer.destroy()
  small.destroy()
  await device.queue.onSubmittedWorkDone()
  device.destroy()
})
