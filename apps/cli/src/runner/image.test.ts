import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import { encode } from 'fast-png'
import jpeg from 'jpeg-js'
import { decodeImage, imageSize } from './image.ts'

const rgba = (width: number, height: number, data: number[]) =>
  encode({ width, height, depth: 8, channels: 4, data: Uint8Array.from(data) })

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

test('PNGs decode to the samples fast-png reads: 8-bit RGBA, 16-bit RGBA, 2- and 4-bit grey', () => {
  const eight = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) % 256)
  const png8 = encode({ width: 5, height: 3, depth: 8, channels: 4, data: eight })
  assert.deepEqual(decodeImage(png8, 'a.png'), { width: 5, height: 3, bits: 8, data: eight })

  const deep = new Uint16Array(5 * 3 * 4).map((_, i) => (i * 2749) % 65536)
  const png16 = encode({ width: 5, height: 3, depth: 16, channels: 4, data: deep })
  assert.deepEqual(decodeImage(png16, 'b.png'), { width: 5, height: 3, bits: 16, data: deep })

  // 2 bits: 0..3 widened to 0, 85, 170, 255; 4 bits: 0..15 to multiples of 17.
  const two = encode({
    width: 4,
    height: 1,
    depth: 2,
    channels: 1,
    data: Uint8Array.of(0b00011011),
  })
  assert.deepEqual(
    [...decodeImage(two, 'c.png').data].filter((_, i) => i % 4 === 0),
    [0, 85, 170, 255],
  )
  const four = encode({ width: 2, height: 1, depth: 4, channels: 1, data: Uint8Array.of(0x1e) })
  assert.deepEqual([...decodeImage(four, 'd.png').data], [17, 17, 17, 255, 238, 238, 238, 255])
})

test('a palette PNG decodes to its colours, and an RGB PNG with tRNS gets its transparency', () => {
  const indexed = encode({
    width: 3,
    height: 1,
    depth: 8,
    channels: 1,
    data: Uint8Array.of(0, 1, 0),
    palette: [
      [10, 20, 30],
      [200, 100, 50],
    ],
  })
  assert.deepEqual(
    [...decodeImage(indexed, 'j.png').data],
    [10, 20, 30, 255, 200, 100, 50, 255, 10, 20, 30, 255],
  )

  // A tRNS chunk naming (1, 2, 3) as the transparent colour, after IHDR (fast-png writes none, and
  // its decoder ignored one).
  const plain = encode({
    width: 2,
    height: 1,
    depth: 8,
    channels: 3,
    data: Uint8Array.of(1, 2, 3, 4, 5, 6),
  })
  const body = Buffer.concat([Buffer.from('tRNS'), Buffer.from([0, 1, 0, 2, 0, 3])])
  const chunk = Buffer.alloc(4 + body.length + 4)
  chunk.writeUInt32BE(6, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), 4 + body.length)
  const keyed = Buffer.concat([plain.subarray(0, 33), chunk, plain.subarray(33)])
  assert.deepEqual([...decodeImage(keyed, 'k.png').data], [1, 2, 3, 0, 4, 5, 6, 255])
})

test('a JPEG decodes at its size, close to jpeg-js (the chroma is smoothed, not repeated)', () => {
  const data = new Uint8Array(16 * 8 * 4).map((_, i) => (i % 4 === 3 ? 255 : 128 + ((i * 7) % 40)))
  const file = jpeg.encode({ width: 16, height: 8, data }, 90).data
  const ours = decodeImage(file, 'p.jpg')
  const theirs = jpeg.decode(file, { useTArray: true, formatAsRGBA: true }).data
  assert.deepEqual([ours.width, ours.height, ours.bits], [16, 8, 8])
  const mean =
    [...ours.data].reduce((s, v, i) => s + Math.abs(v - (theirs[i] as number)), 0) / theirs.length
  assert.ok(mean < 3, `mean difference ${mean}`)
})

test('maxSize shrinks with the box filter, weighted by alpha, rounding half up once a pass', () => {
  // 4×2 at maxSize 2 is 2×1. Worked by hand: left half (100,0,0)+(200,0,0) over (10,20,30)×2
  // gives (80,10,15,255); right half, a transparent pixel beside (40,80,120) over two
  // transparent ones, keeps the colour and averages the alpha: 255/2 = 128, then 128/2 = 64.
  // biome-ignore format: a picture
  const file = rgba(4, 2, [
    100, 0, 0, 255,  200, 0, 0, 255,  9, 9, 9, 0,  40, 80, 120, 255,
    10, 20, 30, 255, 10, 20, 30, 255, 9, 9, 9, 0,  9, 9, 9, 0,
  ])
  const small = decodeImage(file, 'e.png', 2)
  assert.deepEqual([small.width, small.height], [2, 1])
  assert.deepEqual([...small.data], [80, 10, 15, 255, 40, 80, 120, 64])
})

test('maxSize keeps the aspect, rounds the short side, never enlarges and keeps 16 bits', () => {
  const file = rgba(5, 1, new Array(20).fill(200))
  const thin = decodeImage(file, 'f.png', 2)
  assert.deepEqual([thin.width, thin.height], [2, 1], 'the short side is at least 1')
  assert.deepEqual(decodeImage(file, 'f.png', 5), decodeImage(file, 'f.png'), 'within maxSize')
  assert.deepEqual(decodeImage(file, 'f.png', 9), decodeImage(file, 'f.png'))

  const deep = encode({
    width: 4,
    height: 4,
    depth: 16,
    channels: 4,
    data: new Uint16Array(64).fill(40000),
  })
  const half = decodeImage(deep, 'g.png', 2)
  assert.deepEqual([half.width, half.height, half.bits], [2, 2, 16])
  assert.deepEqual([...half.data], new Array(16).fill(40000))
})

test('a still large enough to grow the decoder memory decodes', () => {
  const data = new Uint8Array(1200 * 1200 * 4).map((_, i) => i % 251)
  const big = decodeImage(
    encode({ width: 1200, height: 1200, depth: 8, channels: 4, data }),
    'l.png',
  )
  assert.deepEqual([big.width, big.height], [1200, 1200])
  assert.deepEqual(big.data, data)
})

test('maxSize is a whole number of pixels up to 65536', () => {
  const file = rgba(1, 1, [1, 2, 3, 4])
  for (const bad of [0, 1.5, -2, 65537, 2 ** 32 + 100])
    assert.throws(() => decodeImage(file, 'm.png', bad), /maxSize is a whole number/, `${bad}`)
})

test('a file that is neither PNG nor JPEG names its path', () => {
  assert.throws(() => decodeImage(Uint8Array.of(1, 2, 3), 'h.gif'), /h\.gif is not a PNG or JPEG/)
})

test('a broken PNG names its path', () => {
  const file = rgba(2, 2, new Array(16).fill(1)).slice(0, 40)
  assert.throws(() => decodeImage(file, 'i.png'), /i\.png/)
})

test('imageSize gives the size decodeImage gives, from the headers, at any maxSize', () => {
  const deep = encode({ width: 6, height: 4, depth: 16, channels: 4, data: new Uint16Array(96) })
  const photo = jpeg.encode({ width: 7, height: 3, data: new Uint8Array(84) }, 90).data
  for (const [file, name] of [
    [deep, 'n.png'],
    [photo, 'o.jpg'],
  ] as const)
    for (const maxSize of [undefined, 1, 3, 5, 9]) {
      const { width, height, bits } = decodeImage(file, name, maxSize)
      assert.deepEqual(
        imageSize(file, name, maxSize),
        { width, height, bits },
        `${name} ${maxSize}`,
      )
    }
  assert.throws(() => imageSize(Uint8Array.of(1, 2, 3), 'h.gif'), /h\.gif is not a PNG or JPEG/)
})
