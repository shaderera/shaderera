// PNG and JPEG decoded in JavaScript for `io.image`, in both hosts (the Node host and the runner
// worker import this module), so every host samples the same pixels: never a canvas or a
// browser's decoder.
import type { DecodedImage } from '@shaderera/core'
import { convertIndexedToRgb, decode as decodePng, hasPngSignature } from 'fast-png'
import jpeg from 'jpeg-js'

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/** Straight RGBA from a PNG or JPEG file's bytes; `path` names it in errors. */
export const decodeImage = (bytes: Uint8Array, path: string): DecodedImage => {
  if (hasPngSignature(bytes)) {
    const png = decodePng(bytes)
    const { width, height } = png
    const bits = png.depth === 16 ? 16 : 8
    let data = png.data as Uint8Array | Uint16Array
    let channels = png.channels
    if (png.palette) {
      data = convertIndexedToRgb(png)
      channels = png.palette[0]?.length ?? 3
    } else if (png.depth !== 8 && png.depth !== 16) {
      // 1, 2 or 4 bits a grey sample, packed from the high bit, each row from a new byte: widened
      // to 8.
      const { depth } = png
      const max = 2 ** depth - 1
      const stride = Math.ceil((width * depth) / 8)
      const packed = data
      data = new Uint8Array(width * height)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const bit = x * depth
          const v = ((packed[y * stride + (bit >> 3)] as number) >> (8 - depth - (bit & 7))) & max
          data[y * width + x] = Math.round((v * 255) / max)
        }
    }
    const out =
      bits === 16 ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4)
    const opaque = bits === 16 ? 65535 : 255
    for (let p = 0; p < width * height; p++) {
      const at = p * channels
      const grey = channels <= 2
      const r = data[at] as number
      out[p * 4] = r
      out[p * 4 + 1] = grey ? r : (data[at + 1] as number)
      out[p * 4 + 2] = grey ? r : (data[at + 2] as number)
      out[p * 4 + 3] =
        channels === 2
          ? (data[at + 1] as number)
          : channels === 4
            ? (data[at + 3] as number)
            : opaque
    }
    return { width, height, bits, data: out }
  }
  if (isJpeg(bytes)) {
    const j = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 })
    return { width: j.width, height: j.height, bits: 8, data: new Uint8Array(j.data) }
  }
  throw new Error(`${path} is not a PNG or JPEG: convert it to PNG once (the plugin image-to-png).`)
}
