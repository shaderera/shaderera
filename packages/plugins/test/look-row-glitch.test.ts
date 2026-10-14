// look-row-glitch, headless on Dawn. Checked: no rows hit is the frame exactly; a pixel sort leaves
// each row's pixels sorted by brightness, the same pixels, alpha and all; pixels outside the range
// stay put; columns sort down; a throw is a rotation of the row; the same seed gives the same bytes.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRowGlitch } from '../look-row-glitch/src/looks/row-glitch.ts'
import { openFrame } from './frame.ts'

const W = 96
const H = 64
const luma = (b: Uint8Array, i: number) =>
  0.2126 * (b[i] ?? 0) + 0.7152 * (b[i + 1] ?? 0) + 0.0722 * (b[i + 2] ?? 0)
const rowOf = (b: Uint8Array, y: number) => Array.from(b.subarray(y * W * 4, (y + 1) * W * 4))
const pixelsOf = (row: number[]) =>
  Array.from({ length: row.length / 4 }, (_, i) => row.slice(i * 4, i * 4 + 4).join(',')).sort()

test('look-row-glitch: sorted runs, untouched pixels, thrown rows, columns', async () => {
  const g = await openFrame(W, H)
  const glitch = createRowGlitch(g.host, { width: W, height: H })
  const { texture, px } = g.frame((x, y) => [
    (x * 37 + y * 11) % 256,
    (x * 91 + y * 7) % 256,
    (x * 13 + y * 53) % 256,
    128 + ((x + y) % 128),
  ])

  assert.deepEqual(await g.read(glitch.apply(texture, { rows: 0 })), px, 'no rows hit')

  const sorted = await g.read(glitch.apply(texture, { rows: 1, shift: 0, sort: 1, range: [0, 1] }))
  for (const y of [0, 17, 63]) {
    for (let x = 1; x < W; x++)
      assert.ok(
        Math.round(luma(sorted, (y * W + x) * 4)) >=
          Math.round(luma(sorted, (y * W + x - 1) * 4)) - 1,
        `row ${y} is dark to bright`,
      )
    assert.deepEqual(pixelsOf(rowOf(sorted, y)), pixelsOf(rowOf(px, y)), 'the same pixels')
  }

  // Only bright pixels sort; the dark ones keep their places.
  const bright = await g.read(
    glitch.apply(texture, { rows: 1, shift: 0, sort: 1, range: [0.5, 1] }),
  )
  for (let i = 0; i < W * H; i++)
    if (luma(px, i * 4) < 0.5 * 255 - 1)
      assert.deepEqual(
        Array.from(bright.subarray(i * 4, i * 4 + 4)),
        Array.from(px.subarray(i * 4, i * 4 + 4)),
      )

  // Columns, bright first.
  const columns = await g.read(
    glitch.apply(texture, {
      rows: 1,
      shift: 0,
      sort: 1,
      range: [0, 1],
      axis: 'columns',
      order: 'descending',
    }),
  )
  for (let y = 1; y < H; y++)
    assert.ok(
      Math.round(luma(columns, (y * W + 5) * 4)) <=
        Math.round(luma(columns, ((y - 1) * W + 5) * 4)) + 1,
    )

  // A throw: each row is the source row turned round, or the row itself.
  const thrown = await g.read(glitch.apply(texture, { rows: 0.5, shift: 0.3, sort: 0, seed: 5 }))
  let moved = 0
  for (let y = 0; y < H; y++) {
    const a = rowOf(px, y).join(',')
    const b = rowOf(thrown, y)
    if (b.join(',') !== a) moved++
    const turns = Array.from({ length: W }, (_, k) =>
      [...b.slice(k * 4), ...b.slice(0, k * 4)].join(','),
    )
    assert.ok(turns.includes(a), `row ${y} is a rotation`)
  }
  assert.ok(moved > 0 && moved < H, 'some rows thrown, not all')
  assert.deepEqual(
    await g.read(glitch.apply(texture, { rows: 0.5, shift: 0.3, sort: 0, seed: 5 })),
    thrown,
  )
  assert.notDeepEqual(
    await g.read(glitch.apply(texture, { rows: 0.5, shift: 0.3, sort: 0, seed: 6 })),
    thrown,
  )
  glitch.dispose()
  g.done()
})
