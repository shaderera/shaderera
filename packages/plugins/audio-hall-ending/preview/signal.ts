// A WAV file's samples, and its level at a time: what the audio-hall-ending preview reads from the
// file the item wrote.

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
