import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Frame, Layer } from './protocol.ts'
import { flattenFrame } from './stack.ts'

const layer: Layer = { color: new Uint8Array(4), alpha: 'opaque' }

test('flattenFrame wraps a Layer and keeps a flat array', () => {
  assert.deepEqual(flattenFrame(layer), [layer])
  const stack = [layer, layer]
  assert.deepEqual(flattenFrame(stack), stack)
})

test('flattenFrame takes bytes without alpha as straight', () => {
  const bytes = { color: new Uint8Array(4) } as unknown as Frame
  assert.deepEqual(flattenFrame(bytes), [{ color: new Uint8Array(4), alpha: 'straight' }])
})

test('flattenFrame rejects nesting and layers without color', () => {
  assert.throws(() => flattenFrame([[layer]] as unknown as Frame), /nesting/)
  assert.throws(() => flattenFrame([{}] as unknown as Frame), TypeError)
})
