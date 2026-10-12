/** Raw RGBA bytes and how their alpha is stored. */
export type RgbaLayer = {
  data: Uint8Array | Uint8ClampedArray
  alpha: 'premultiplied' | 'straight' | 'opaque'
  /**
   * Where the layer is, one distance per pixel (Infinity: nowhere): its pixels are hidden where a
   * layer below with depth is nearer, and its opaque pixels hide what comes later behind them.
   * `soft`, in the same units: how far behind a pixel fades out instead of cutting off.
   */
  depth?: { data: Float32Array; soft?: number }
}

/**
 * Porter-Duff source-over, bottom to top from transparent black; returns premultiplied RGBA.
 * Layers with depth are also depth-tested against each other (layers without depth are not).
 */
export const over = (layers: readonly RgbaLayer[], width: number, height: number): Uint8Array => {
  const size = width * height * 4
  const out = new Uint8Array(size)
  const nearest = layers.some((l) => l.depth)
    ? new Float32Array(width * height).fill(Number.POSITIVE_INFINITY)
    : null
  for (const { data, alpha, depth } of layers) {
    if (data.length !== size) {
      throw new Error(`A layer has ${data.length} bytes; ${width}x${height} RGBA needs ${size}.`)
    }
    if (depth && depth.data.length !== width * height) {
      throw new Error(
        `A layer's depth has ${depth.data.length} values; ${width}x${height} needs ${width * height}.`,
      )
    }
    if (alpha === 'opaque' && !depth) {
      out.set(data)
      for (let i = 3; i < size; i += 4) out[i] = 255
      continue
    }
    const straight = alpha !== 'premultiplied'
    const soft = depth?.soft ?? 0
    for (let i = 0; i < size; i += 4) {
      const a = alpha === 'opaque' ? 255 : (data[i + 3] as number)
      if (a === 0) continue
      // Seen: 1 in front of what is nearest so far, 0 behind it (by `soft`, a ramp).
      let seen = 1
      if (depth && nearest) {
        const p = i >> 2
        const d = depth.data[p] as number
        const z = nearest[p] as number
        seen = d <= z ? 1 : soft > 0 ? Math.max(0, 1 - (d - z) / soft) : 0
        if (seen === 0) continue
        if (a === 255 && d < z) nearest[p] = d
      }
      const k = Math.round(a * seen)
      if (k === 255) {
        out[i] = data[i] as number
        out[i + 1] = data[i + 1] as number
        out[i + 2] = data[i + 2] as number
        out[i + 3] = 255
        continue
      }
      const keep = 255 - k
      for (let c = i; c < i + 3; c++) {
        const v = data[c] as number
        // Straight colour times its coverage; premultiplied colour scaled by what is seen of it.
        const src = straight ? Math.round((v * k) / 255) : Math.round(v * seen)
        out[c] = Math.min(255, src + Math.round(((out[c] as number) * keep) / 255))
      }
      out[i + 3] = k + Math.round(((out[i + 3] as number) * keep) / 255)
    }
  }
  return out
}

/**
 * RGBA bytes with straight alpha, as an `ImageData` wants them: opaque bytes get alpha 255,
 * premultiplied colour is divided by its alpha, and a premultiplied pixel with alpha 0 is black.
 */
export const straight = ({ data, alpha }: RgbaLayer): Uint8ClampedArray<ArrayBuffer> => {
  const out = new Uint8ClampedArray(data)
  if (alpha === 'straight') return out
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] as number
    if (alpha === 'opaque') out[i + 3] = 255
    else if (a === 0) out.fill(0, i, i + 3)
    else if (a < 255) for (let c = i; c < i + 3; c++) out[c] = ((out[c] as number) * 255) / a
  }
  return out
}

/**
 * Straight RGBA over opaque black: what a delivery without alpha (an mp4) shows. Every encoder
 * path matte its frames with this, once, at the sink; the bytes before it stay straight.
 */
export const matte = (data: Uint8Array | Uint8ClampedArray): Uint8Array => {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] as number
    for (let c = i; c < i + 3; c++) out[c] = Math.round(((data[c] as number) * a) / 255)
    out[i + 3] = 255
  }
  return out
}
