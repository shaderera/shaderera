import assert from 'node:assert/strict'
import { test } from 'node:test'
import { over, straight } from './over.ts'

const px = (...v: number[]) => new Uint8Array(v)

test('over composites straight and premultiplied layers', () => {
  const bottom = { data: px(200, 0, 0, 255), alpha: 'opaque' as const }
  const top = { data: px(0, 255, 0, 128), alpha: 'straight' as const }
  assert.deepEqual(over([bottom, top], 1, 1), px(100, 128, 0, 255))
  const pre = { data: px(0, 128, 0, 128), alpha: 'premultiplied' as const }
  assert.deepEqual(over([bottom, pre], 1, 1), px(100, 128, 0, 255))
})

test('over starts transparent, skips transparent pixels, replaces with opaque', () => {
  assert.deepEqual(over([], 1, 1), px(0, 0, 0, 0))
  assert.deepEqual(over([{ data: px(1, 2, 3, 0), alpha: 'premultiplied' }], 1, 1), px(0, 0, 0, 0))
  assert.deepEqual(over([{ data: px(1, 2, 3, 7), alpha: 'opaque' }], 1, 1), px(1, 2, 3, 255))
})

test('over rejects a layer of the wrong size', () => {
  assert.throws(() => over([{ data: px(0, 0, 0), alpha: 'opaque' }], 1, 1))
})

test('straight gives an opaque layer alpha 255 and a premultiplied alpha-0 pixel black', () => {
  assert.deepEqual(
    straight({ data: px(1, 2, 3, 0), alpha: 'opaque' }),
    new Uint8ClampedArray([1, 2, 3, 255]),
  )
  assert.deepEqual(
    straight({ data: px(9, 9, 9, 0, 0, 64, 0, 128), alpha: 'premultiplied' }),
    new Uint8ClampedArray([0, 0, 0, 0, 0, 128, 0, 128]),
  )
  assert.deepEqual(
    straight({ data: px(1, 2, 3, 0), alpha: 'straight' }),
    new Uint8ClampedArray([1, 2, 3, 0]),
  )
})

test('an opaque layer with alpha 0 is opaque in both hosts', () => {
  const layer = { data: px(10, 20, 30, 0), alpha: 'opaque' as const }
  assert.deepEqual([...over([layer], 1, 1)], [...straight(layer)])
})

test('a layer with depth is hidden behind a nearer one below it, and fades over soft', () => {
  const near = {
    data: px(200, 0, 0, 255, 200, 0, 0, 255),
    alpha: 'opaque' as const,
    depth: { data: new Float32Array([1, 5]) },
  }
  const ui = {
    data: px(0, 255, 0, 255, 0, 255, 0, 255),
    alpha: 'straight' as const,
    depth: { data: new Float32Array([2, 2]) },
  }
  // Pixel 0: the red layer is nearer (1 < 2), the green hidden; pixel 1: green in front (2 < 5).
  assert.deepEqual(over([near, ui], 2, 1), px(200, 0, 0, 255, 0, 255, 0, 255))
  const soft = { ...ui, depth: { data: new Float32Array([1.5, 2]), soft: 1 } }
  // Pixel 0: 0.5 behind with a soft of 1 → half seen.
  assert.deepEqual(over([near, soft], 2, 1).slice(0, 4), px(100, 128, 0, 255))
})

test('layers without depth composite as before when another has depth', () => {
  const back = {
    data: px(10, 10, 10, 255),
    alpha: 'opaque' as const,
    depth: { data: new Float32Array([1]) },
  }
  const plain = { data: px(0, 255, 0, 255), alpha: 'straight' as const }
  assert.deepEqual(over([back, plain], 1, 1), px(0, 255, 0, 255))
})
