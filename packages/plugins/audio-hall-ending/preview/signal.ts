// A WAV file's samples, and what the previews draw from them: the level and the spectrum per
// frame. Used by the audio-hall-ending and review-av-timeline previews to read the sound they play.

import type { Host } from '@shaderera/core'

export type Signal = { rate: number; mono: Float32Array; length: number }

/** A PCM WAV (16, 24 or 32-bit integer, or 32-bit float), mixed to mono. */
export const readWav = async (host: Host, path: string): Promise<Signal> => {
  const bytes = await host.io.read(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error(`${path} is not a WAV file`)
  let format = 1
  let channels = 2
  let rate = 48000
  let bits = 16
  let data: Uint8Array | undefined
  for (let o = 12; o + 8 <= bytes.length; ) {
    const size = view.getUint32(o + 4, true)
    if (tag(o) === 'fmt ') {
      format = view.getUint16(o + 8, true)
      channels = view.getUint16(o + 10, true)
      rate = view.getUint32(o + 12, true)
      bits = view.getUint16(o + 22, true)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe) format = view.getUint16(o + 32, true)
    } else if (tag(o) === 'data') data = bytes.subarray(o + 8, o + 8 + size)
    o += 8 + size + (size % 2)
  }
  if (!data) throw new Error(`${path} has no data chunk`)
  const step = bits / 8
  const frames = Math.floor(data.length / (step * channels))
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const sample = (i: number) => {
    const o = i * step
    if (format === 3) return d.getFloat32(o, true)
    if (bits === 16) return d.getInt16(o, true) / 32768
    if (bits === 24) {
      const v = (d.getUint8(o) | (d.getUint8(o + 1) << 8) | (d.getInt8(o + 2) << 16)) >>> 0
      return ((v << 8) >> 8) / 8388608
    }
    return d.getInt32(o, true) / 2147483648
  }
  const mono = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let s = 0
    for (let c = 0; c < channels; c++) s += sample(f * channels + c)
    mono[f] = s / channels
  }
  return { rate, mono, length: frames / rate }
}

/** The peak and RMS level in dBFS of `window` seconds ending at t, and whether it is all zeros. */
export const levelAt = (s: Signal, t: number, window = 1 / 30) => {
  const b = Math.min(s.mono.length, Math.max(0, Math.round(t * s.rate)))
  const a = Math.max(0, b - Math.round(window * s.rate))
  let sum = 0
  let peak = 0
  for (let i = a; i < b; i++) {
    const v = s.mono[i] ?? 0
    sum += v * v
    peak = Math.max(peak, Math.abs(v))
  }
  const n = Math.max(1, b - a)
  return {
    rms: 10 * Math.log10(sum / n || 1e-30),
    peak: 20 * Math.log10(peak || 1e-30),
    silent: peak === 0,
  }
}

const fft = (re: Float64Array, im: Float64Array) => {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j] as number, re[i] as number]
      ;[im[i], im[j]] = [im[j] as number, im[i] as number]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k)
        const wi = Math.sin(a * k)
        const p = i + k
        const q = p + len / 2
        const xr = (re[q] as number) * wr - (im[q] as number) * wi
        const xi = (re[q] as number) * wi + (im[q] as number) * wr
        re[q] = (re[p] as number) - xr
        im[q] = (im[p] as number) - xi
        re[p] = (re[p] as number) + xr
        im[p] = (im[p] as number) + xi
      }
  }
}

/**
 * The spectrum `perSecond` times a second over the signal, in `bands` log-spaced bands from `low`
 * to `high` Hz, each in dBFS: row r (time r / perSecond) is `db[r * bands … r * bands + bands]`.
 */
export const spectrogram = (
  s: Signal,
  o: { perSecond: number; bands: number; low?: number; high?: number; size?: number },
) => {
  const size = o.size ?? 2048
  const low = o.low ?? 40
  const high = o.high ?? 16000
  const rows = Math.ceil(s.length * o.perSecond)
  const db = new Float32Array(rows * o.bands).fill(-120)
  const edges = Array.from(
    { length: o.bands + 1 },
    (_, i) => (low * (high / low) ** (i / o.bands) * size) / s.rate,
  )
  const hann = Float64Array.from(
    { length: size },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size),
  )
  const norm = 4 / size
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let r = 0; r < rows; r++) {
    const centre = Math.round((r / o.perSecond) * s.rate)
    for (let i = 0; i < size; i++) {
      re[i] = (s.mono[centre - size / 2 + i] ?? 0) * (hann[i] as number)
      im[i] = 0
    }
    fft(re, im)
    for (let b = 0; b < o.bands; b++) {
      const from = Math.floor(edges[b] as number)
      const to = Math.max(from + 1, Math.ceil(edges[b + 1] as number))
      let m = 0
      for (let k = from; k < to && k < size / 2; k++)
        m = Math.max(m, ((re[k] as number) ** 2 + (im[k] as number) ** 2) * norm * norm)
      db[r * o.bands + b] = 10 * Math.log10(m || 1e-12)
    }
  }
  return { rows, bands: o.bands, perSecond: o.perSecond, db }
}
