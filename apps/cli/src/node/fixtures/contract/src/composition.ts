import type { AudioClip, Caption, Open } from '@shaderera/core'

/**
 * The contract suite's film (node/contract.it.ts): one layer of bytes whose left half changes
 * with t, opaque, and whose right half is straight (200, 120, 40) at alpha 128; inspect, sound
 * from a file and made in code, and captions; inspect reports the seed. With `silent`, it has no audio() and no
 * captions(). The render at 0.7 s throws.
 */
export const paint = (t: number, width: number, height: number) => {
  const bytes = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      bytes.set(
        x < width / 2 ? [Math.round(20 + 200 * t), 80, 160, 255] : [200, 120, 40, 128],
        (y * width + x) * 4,
      )
  return bytes
}

export const clips: AudioClip[] = [
  { src: 'audio/bed.wav', at: 0, gain: 0.5 },
  {
    pcm: {
      sampleRate: 8000,
      channels: [Float32Array.from({ length: 800 }, (_, i) => Math.sin(i / 4) / 2)],
    },
    at: 0.25,
  },
]

export const captions: Caption[] = [
  { start: 0, end: 0.5, text: 'Hello' },
  { start: 0.5, end: 1, text: 'สวัสดี\nagain' },
]

export const FAILS_AT = 0.7

const open: Open = ({ manifest, params, seed }) => {
  const { width, height } = manifest
  return {
    render: async (t) => {
      if (Math.abs(t - FAILS_AT) < 1e-9) throw new Error(`The film fails at ${FAILS_AT} s.`)
      return { color: paint(t, width, height), alpha: 'straight', name: 'card' }
    },
    inspect: async (t) => ({ card: { red: Math.round(20 + 200 * t), t }, seed }),
    ...(params.silent ? {} : { audio: async () => clips, captions: async () => captions }),
  }
}
export default open
