// 16-bit RGBA helpers, apart from ffmpeg.ts so the encoder thread (encoder.ts) loads only these.

/**
 * Little-endian 16-bit words over bytes: a view at an even offset, a copy at an odd one (a Node
 * Buffer can start anywhere in its pool, and a Uint16Array cannot).
 */
export const words16 = (data: Uint8Array | Uint8ClampedArray): Uint16Array =>
  data.byteOffset % 2 === 0
    ? new Uint16Array(data.buffer, data.byteOffset, data.length >> 1)
    : new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))

/** `matte` at 16 bits a channel: straight little-endian RGBA over black, alpha made opaque. */
export const matte64 = (data: Uint8Array | Uint8ClampedArray): Uint8Array => {
  const src = words16(data)
  const out = new Uint16Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] as number
    for (let c = i; c < i + 3; c++) out[c] = Math.round(((src[c] as number) * a) / 65535)
    out[i + 3] = 65535
  }
  return new Uint8Array(out.buffer)
}
