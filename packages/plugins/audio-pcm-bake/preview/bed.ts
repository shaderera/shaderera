// The audio-pcm-bake preview's bed, made in code: the module the item's tool bakes, a slow chord of
// sines whose pitches it reads from audio/pcm-bed.json (the input listed with --inputs), each
// breathing at its own rate with a phase from the seed. Every pitch and breath is a whole number of
// cycles in the film's duration, so the 6 s loop is seamless. preview/make.ts copies it to
// audio/pcm-bed.ts in the previews project.

import { readFileSync } from 'node:fs'
import type { Pcm } from '@shaderera/core'

const RATE = 48000
const LEVEL = 0.04

const hash = (k: number, seed: number) => {
  const s = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453
  return s - Math.floor(s)
}

export default (duration: number, seed: number): Pcm => {
  const { hz } = JSON.parse(readFileSync('audio/pcm-bed.json', 'utf8')) as { hz: number[] }
  const n = Math.round(duration * RATE)
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  hz.forEach((f, k) => {
    const phase = hash(k, seed)
    const breaths = 1 + (k % 3)
    const pan = (k / Math.max(1, hz.length - 1) - 0.5) * 0.6
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((breaths * t) / duration + phase))
      const v = LEVEL * env * Math.sin(2 * Math.PI * (f * t + phase))
      l[i] = (l[i] ?? 0) + v * (1 - pan)
      r[i] = (r[i] ?? 0) + v * (1 + pan)
    }
  })
  return { sampleRate: RATE, channels: [l, r] }
}
