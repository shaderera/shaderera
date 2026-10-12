import { crc32, deflateSync } from 'node:zlib'

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/**
 * An RGBA PNG of straight-alpha pixels, tagged sRGB: 8 bits a channel from bytes, or 16 from
 * the compositor's `rgba64` (little-endian in, big-endian in the file, as PNG stores it). Written here rather than through a
 * canvas, which would premultiply on the way in and lose low-alpha colour; the bytes out are the
 * bytes in, and the same pixels always give the same file.
 */
/** Little-endian 16-bit words to big-endian, in place. */
const swapRow = (buf: Buffer, at: number, length: number) => {
  for (let i = at; i < at + length; i += 2) {
    const lo = buf[i] as number
    buf[i] = buf[i + 1] as number
    buf[i + 1] = lo
  }
}

export const encodePng = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  bits: 8 | 16 = 8,
) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([bits, 6, 0, 0, 0], 8) // bit depth, RGBA, deflate, no filter method, no interlace
  const row = width * 4 * (bits / 8)
  if (rgba.length !== row * height)
    throw new Error(
      `${width}x${height} at ${bits} bits needs ${row * height} bytes, not ${rgba.length}.`,
    )
  const raw = Buffer.alloc((row + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (row + 1)] = 0
    raw.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1)
  }
  if (bits === 16) for (let y = 0; y < height; y++) swapRow(raw, y * (row + 1) + 1, row)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Buffer.from([0])), // perceptual
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
