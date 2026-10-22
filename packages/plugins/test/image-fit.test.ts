// image-fit: copied into a project the way `add` lays it out, its rectangles checked as numbers,
// and the pyramid drawn headless on @napi-rs/canvas in two orders, byte for byte.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Canvas } from '@napi-rs/canvas'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'image-fit')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'image-fit', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'image-fit', f), join(project, f))
}
const { contain, cover, crop, drawFrom, pyramid, toCanvas } = (await import(
  pathToFileURL(join(project, 'src/image/fit.ts')).href
)) as typeof import('../image-fit/src/image/fit.ts')
type Rect = import('../image-fit/src/image/fit.ts').Rect
type Pyramid = import('../image-fit/src/image/fit.ts').Pyramid
type Fit = import('../image-fit/src/image/fit.ts').Fit

const io = { canvas: (w: number, h: number) => new Canvas(w, h) as unknown as OffscreenCanvas }
const e = 1e-9
const near = (a: number, b: number, what: string) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`)
const within = (r: Rect, outer: Rect) =>
  r.x >= outer.x - e &&
  r.y >= outer.y - e &&
  r.x + r.width <= outer.x + outer.width + e &&
  r.y + r.height <= outer.y + outer.height + e

const pictures = [
  { width: 4000, height: 3000 },
  { width: 1080, height: 1920 },
  { width: 501, height: 499 },
  { width: 8000, height: 300 },
]
const boxes: Rect[] = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 40, y: 60, width: 300, height: 900 },
  { x: -10, y: 5.5, width: 777, height: 777 },
  { x: 100, y: 100, width: 2000, height: 50 },
]
const all = { x: 0, y: 0 }

test('image-fit: cover always fills the box, from inside the picture', () => {
  for (const p of pictures)
    for (const box of boxes) {
      const { source, target } = cover(p, box)
      assert.deepEqual(target, box, 'the target is the box')
      near(source.width / source.height, box.width / box.height, 'the box aspect')
      assert.ok(within(source, { ...all, ...p }), 'inside the picture')
      assert.ok(
        Math.abs(source.width - p.width) < e || Math.abs(source.height - p.height) < e,
        'as large as it can be',
      )
    }
})

test('image-fit: contain always fits inside the box, the whole picture', () => {
  for (const p of pictures)
    for (const box of boxes)
      for (const align of [undefined, [0, 0], [1, 1], [0.3, 0.8]] as const) {
        const { source, target } = contain(p, box, align)
        assert.deepEqual(source, { ...all, ...p }, 'the whole picture')
        near(target.width / target.height, p.width / p.height, 'its own aspect')
        assert.ok(within(target, box), 'inside the box')
        assert.ok(
          Math.abs(target.width - box.width) < e || Math.abs(target.height - box.height) < e,
          'as large as it fits',
        )
      }
  const low = contain({ width: 100, height: 100 }, { x: 0, y: 0, width: 300, height: 100 }, [1, 1])
  assert.deepEqual(low.target, { x: 200, y: 0, width: 100, height: 100 }, 'align')
})

test('image-fit: the focal point stays inside the crop, centred when it can be', () => {
  for (const p of pictures)
    for (const box of boxes)
      for (const fx of [0, 0.01, 0.3, 0.5, 0.97, 1])
        for (const fy of [0, 0.2, 0.5, 0.99, 1]) {
          const focus = [fx * p.width, fy * p.height] as const
          const { source } = cover(p, box, focus)
          assert.ok(within(source, { ...all, ...p }), 'inside the picture')
          assert.ok(
            within({ x: focus[0], y: focus[1], width: 0, height: 0 }, source),
            `${JSON.stringify([p, box, focus])}`,
          )
        }
  const tall = cover({ width: 4000, height: 3000 }, boxes[1] as Rect, [2100, 1600]).source
  near(tall.x + tall.width / 2, 2100, 'centred across')
  const wide = cover({ width: 4000, height: 3000 }, boxes[0] as Rect, [2100, 1600]).source
  near(wide.y + wide.height / 2, 1600, 'centred down')
  const v = crop({ width: 4000, height: 3000 }, 1, [3900, 100], 1000)
  assert.deepEqual(v, { x: 3000, y: 0, width: 1000, height: 1000 }, 'slid back in at a width')
})

test('image-fit: a decoded image onto a canvas, 8 and 16 bits', () => {
  const data = new Uint8Array([255, 0, 0, 255, 0, 128, 255, 255])
  const c8 = toCanvas(io, { width: 2, height: 1, bits: 8, data })
  const read = (c: OffscreenCanvas) => [
    ...(c.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(0, 0, 2, 1).data,
  ]
  assert.deepEqual(read(c8), [...data])
  const wide = new Uint16Array([65535, 0, 0, 65535, 0, 32896, 65535, 65535])
  assert.deepEqual(read(toCanvas(io, { width: 2, height: 1, bits: 16, data: wide })), [...data])
})

test('image-fit: footage frames onto one canvas, the bytes putImageData gives', () => {
  const [w, h] = [37, 23]
  const frame = (seed: number) =>
    Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 131 + seed * 977 + (i >> 5)) % 256)
  const bytes = (c: OffscreenCanvas) =>
    (c.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(0, 0, w, h).data
  const byHand = (pixels: Uint8Array) => {
    const c = io.canvas(w, h)
    const x = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    const d = x.createImageData(w, h)
    d.data.set(pixels)
    x.putImageData(d, 0, 0)
    return bytes(c)
  }
  const one = io.canvas(w, h)
  for (const seed of [1, 2, 3]) {
    const pixels = frame(seed)
    const fresh = toCanvas(io, { width: w, height: h, data: pixels })
    assert.deepEqual(bytes(fresh), byHand(pixels), 'byte-equal to putImageData by hand')
    assert.equal(toCanvas(io, { width: w, height: h, data: pixels }, one), one, 'the same canvas')
    assert.deepEqual(bytes(one), bytes(fresh), 'reused gives the bytes a fresh one does')
  }
  assert.throws(() => toCanvas(io, { width: w, height: h, data: frame(0) }, io.canvas(w, h + 1)))
})

/** A busy still: rings and a checker, so any change of filter or level shows in the bytes. */
const still = (w: number, h: number, seed: number) => {
  const c = io.canvas(w, h)
  const x = c.getContext('2d') as OffscreenCanvasRenderingContext2D
  const cell = 7 + seed
  for (let j = 0; j < h / cell; j++)
    for (let i = 0; i < w / cell; i++) {
      x.fillStyle = `rgb(${(i * 37 + seed * 50) % 256},${(j * 59) % 256},${((i + j) * 23) % 256})`
      x.fillRect(i * cell, j * cell, cell, cell)
    }
  x.strokeStyle = '#fff'
  x.lineWidth = 3
  for (let r = 10; r < Math.max(w, h); r += 31) {
    x.beginPath()
    x.arc(w / 2, h / 2, r, 0, Math.PI * 2)
    x.stroke()
  }
  return c
}

test('image-fit: the pyramid draws the same bytes in either draw order', () => {
  const W = 640
  const H = 360
  const stills = [still(3000, 2000, 1), still(1999, 3001, 2), still(4100, 900, 3)].map((c) =>
    pyramid(io, c),
  )
  for (const p of stills) {
    const last = p.levels[p.levels.length - 1] as OffscreenCanvas
    assert.ok(Math.max(last.width, last.height) <= 64, 'halved down to 64')
  }
  const box = { x: 0, y: 0, width: W, height: H }
  const fits = stills.flatMap((p) => [
    cover(p, box),
    cover(p, box, [p.width * 0.9, p.height * 0.1]),
    contain(p, { x: 30, y: 20, width: 200, height: 300 }),
    // a source past the picture's edge: cut, not sampled
    { source: { x: -200, y: -100, width: p.width, height: p.height }, target: box },
  ])
  const draws = fits.map((f, i) => ({ p: stills[Math.floor(i / 4)] as Pyramid, f }))
  const hashes = (order: number[]) => {
    const out: string[] = []
    for (const k of order) {
      const c = io.canvas(W, H)
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
      const { p, f } = draws[k] as (typeof draws)[0]
      drawFrom(ctx, p, f.source, f.target)
      out[k] = createHash('sha256')
        .update(ctx.getImageData(0, 0, W, H).data)
        .digest('hex')
      // something else drawn between: a level of another still, at another scale
      const other = stills[(k + 1) % stills.length] as Pyramid
      ctx.drawImage(other.levels[1] as OffscreenCanvas, 0, 0, W * 2, H * 2)
    }
    return out
  }
  const forward = hashes(draws.map((_, i) => i))
  const backward = hashes(draws.map((_, i) => draws.length - 1 - i))
  assert.deepEqual(backward, forward)
  assert.ok(new Set(forward).size > draws.length / 2, 'the draws differ from each other')
})

test('image-fit: drawFrom a plain canvas or a pyramid is the drawImage written by hand', () => {
  const W = 640
  const H = 360
  const frame = still(1280, 720, 4)
  const photo = pyramid(io, still(3000, 2000, 5))
  const box = { x: 0, y: 0, width: W, height: H }
  const bytes = (draw: (ctx: OffscreenCanvasRenderingContext2D) => void) => {
    const ctx = io.canvas(W, H).getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    draw(ctx)
    return ctx.getImageData(0, 0, W, H).data
  }
  const byHand = (from: OffscreenCanvas, k: number, { source: s, target: t }: Fit) =>
    bytes((ctx) => {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'low'
      ctx.drawImage(from, s.x * k, s.y * k, s.width * k, s.height * k, t.x, t.y, t.width, t.height)
    })
  for (const f of [
    cover(frame, box),
    cover(frame, box, [1200, 50]),
    contain(frame, { x: 30, y: 20, width: 200, height: 300 }),
  ])
    assert.deepEqual(
      bytes((ctx) => drawFrom(ctx, frame, f.source, f.target)),
      byHand(frame, 1, f),
      'a canvas: drawn once',
    )
  // 3000 wide into 640: no more than twice the size drawn is level 2, a quarter
  const f = cover(photo, box)
  assert.deepEqual(
    bytes((ctx) => drawFrom(ctx, photo, f.source, f.target)),
    byHand(photo.levels[2] as OffscreenCanvas, 0.25, f),
    'a pyramid: from its level',
  )
})
