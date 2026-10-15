import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitsLine } from './doctor.ts'

test('limitsLine names the limits films run into, in MB and pixels', () => {
  assert.equal(
    limitsLine({
      maxBufferSize: 2 ** 31,
      maxStorageBufferBindingSize: 2 ** 27,
      maxTextureDimension2D: 16384,
      maxTextureArrayLayers: 2048,
    }),
    'buffers to 2048 MB, storage binding 128 MB, textures to 16384 px, 2048 layers',
  )
})
