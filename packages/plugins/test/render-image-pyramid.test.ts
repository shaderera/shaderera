// render-image-pyramid, headless: copied into a project the way `add` lays it out, pyramids built on
// @napi-rs/canvas as the Node host builds them. Checked: the halves and where they stop; the level
// a draw reads, by the larger of the two axes' ratios, at each axis's own scale; nothing drawn for a
// zero size; and the same crop drawn twice, with other large pictures drawn in between at 'high'
// smoothing, gives the same bytes. Skia's cache eviction does not show on @napi-rs/canvas (plain
// 'high' smoothing passes that last test too), so it checks only that blit is stable; the level
// tests are what fail without the pyramid.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Canvas } from '@napi-rs/canvas'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'render-image-pyramid')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'render-image-pyramid', 'shaderera.item.json'), 'utf8'),
) as {
  files: string[]
}
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'render-image-pyramid', f), join(project, f))
}
const { blit, pyramid } = (await import(
  pathToFileURL(join(project, 'src/render/pyramid.ts')).href
)) as typeof import('../render-image-pyramid/src/render/pyramid.ts')

type Ctx = OffscreenCanvasRenderingContext2D
const io = { canvas: (w: number, h: number) => new Canvas(w, h) as unknown as OffscreenCanvas }

/** A w×h picture of hashed noise, different per seed: the worst case for resampling. */
const noise = (w: number, h: number, seed: number) => {
  const c = io.canvas(w, h)
  const g = c.getContext('2d') as Ctx
  const img = g.createImageData(w, h)
  for (let i = 0; i < img.data.length; i++)
    img.data[i] = i % 4 === 3 ? 255 : Math.imul(i + seed * 7919, 2654435761) >>> 24
  g.putImageData(img, 0, 0)
  return c
}
const bytes = (c: OffscreenCanvas) =>
  Buffer.from((c.getContext('2d') as Ctx).getImageData(0, 0, c.width, c.height).data)

test('render-image-pyramid: halves down to the longest side asked, the picture itself as level 0', () => {
  const picture = noise(4001, 2999, 1)
  const p = pyramid(io, picture)
  assert.equal(p.levels[0], picture)
  assert.deepEqual(
    p.levels.map((l) => [l.width, l.height]),
    [
      [4001, 2999],
      [2001, 1500],
      [1001, 750],
    ],
  )
  assert.deepEqual([p.width, p.height], [4001, 2999])
  assert.equal(pyramid(io, picture, { min: 300 }).levels.length, 5)
  assert.equal(pyramid(io, noise(800, 600, 1)).levels.length, 1)
  assert.throws(() => pyramid(io, picture, { min: 0 }), /min must be at least 1 px/)
})

test('render-image-pyramid: a draw reads the level at most twice its size, at that level’s scale', () => {
  const p = pyramid(io, noise(4000, 3000, 2))
  const draw = (f: (g: Ctx) => void) => {
    const c = io.canvas(400, 300)
    f(c.getContext('2d') as Ctx)
    return bytes(c)
  }
  const direct = (i: number, k: number, sx: number, sy: number, sw: number, sh: number) =>
    draw((g) => {
      g.imageSmoothingQuality = 'low'
      g.drawImage(p.levels[i] as OffscreenCanvas, sx * k, sy * k, sw * k, sh * k, 0, 0, 400, 300)
    })
  // 3000 px wide into 400: 7.5 times smaller, so the quarter (1000 px, 2.5 times the size drawn).
  assert.ok(
    draw((g) => blit(g, p, 400, 300, 3000, 2250, 0, 0, 400, 300)).equals(
      direct(2, 1 / 4, 400, 300, 3000, 2250),
    ),
  )
  // 900 into 400 reads the half (450 px); 700 into 400, and 300 into 400, the picture itself.
  assert.ok(
    draw((g) => blit(g, p, 0, 0, 900, 675, 0, 0, 400, 300)).equals(
      direct(1, 1 / 2, 0, 0, 900, 675),
    ),
  )
  assert.ok(
    draw((g) => blit(g, p, 0, 0, 700, 525, 0, 0, 400, 300)).equals(direct(0, 1, 0, 0, 700, 525)),
  )
  assert.ok(
    draw((g) => blit(g, p, 50, 50, 300, 225, 0, 0, 400, 300)).equals(
      direct(0, 1, 50, 50, 300, 225),
    ),
  )
  // Squeezed: 900 into 400 across but 2700 into 300 down, 9 times smaller, so the quarter, the last.
  assert.ok(
    draw((g) => blit(g, p, 0, 0, 900, 2700, 0, 0, 400, 300)).equals(
      direct(2, 1 / 4, 0, 0, 900, 2700),
    ),
  )
  // Nothing drawn, and no throw, when a side is 0.
  const blank = draw(() => {})
  assert.ok(draw((g) => blit(g, p, 0, 0, 0, 10, 0, 0, 0, 10)).equals(blank))
  assert.ok(draw((g) => blit(g, p, 0, 0, 10, 0, 0, 0, 10, 0)).equals(blank))
})

test('render-image-pyramid: an odd-sized picture’s level is read at its own scale on each axis', () => {
  const p = pyramid(io, noise(4001, 2999, 4))
  const l = p.levels[1] as OffscreenCanvas // 2001 × 1500
  const draw = (f: (g: Ctx) => void) => {
    const c = io.canvas(400, 300)
    f(c.getContext('2d') as Ctx)
    return bytes(c)
  }
  const [kx, ky] = [l.width / 4001, l.height / 2999]
  assert.ok(
    draw((g) => blit(g, p, 1001, 1001, 1000, 1000, 0, 0, 400, 300)).equals(
      draw((g) => {
        g.imageSmoothingQuality = 'low'
        g.drawImage(l, 1001 * kx, 1001 * ky, 1000 * kx, 1000 * ky, 0, 0, 400, 300)
      }),
    ),
  )
})

test('render-image-pyramid: the same crop twice, other large pictures drawn between, the same bytes', () => {
  const p = pyramid(io, noise(4000, 3000, 3))
  const frame = io.canvas(540, 405)
  const g = frame.getContext('2d') as Ctx
  const crop = () => {
    g.clearRect(0, 0, frame.width, frame.height)
    blit(g, p, 310, 170, 3020, 2265, 0, 0, frame.width, frame.height)
    return bytes(frame)
  }
  const first = crop()
  for (let k = 0; k < 6; k++) {
    g.imageSmoothingQuality = 'high'
    g.drawImage(noise(4000, 3000, 10 + k), 0, 0, frame.width, frame.height)
    blit(g, pyramid(io, noise(3600, 3600, 20 + k)), 0, 0, 3600, 3600, 0, 0, 200, 200)
  }
  assert.ok(crop().equals(first))
})
