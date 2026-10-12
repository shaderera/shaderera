import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encode } from 'fast-png'
import { decodeImage } from './image.ts'

test('a 1-bit greyscale PNG decodes one pixel a bit', () => {
  const png = encode({
    width: 8,
    height: 2,
    depth: 1,
    channels: 1,
    data: Uint8Array.of(0xaa, 0x0f),
  })
  const grey = [...decodeImage(png, 'x.png').data].filter((_, i) => i % 4 === 0)
  assert.deepEqual(grey, [255, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255])
})
