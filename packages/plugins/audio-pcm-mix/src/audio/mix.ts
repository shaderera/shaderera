// Sound made in code, placed on the film's timeline: a buffer that covers a span of the film,
// sounds added to it at film seconds with a gain and a constant-power pan, seeded noise, the
// numbers to check before it plays, and core's Pcm to return from audio(). No taste: nothing here
// normalizes, limits or colours the mix; the film scales its own.

import type { Pcm } from '@shaderera/core'
import { stream } from '../motion/random.ts'

/** A mix: one or two channels covering the film from `start` seconds, `sampleRate` samples a second. */
export type MixBuffer = {
  readonly sampleRate: number
  readonly start: number
  readonly channels: readonly Float32Array[]
}

/** A silent buffer `duration` seconds long, covering the film from `start` (0 by default). */
export const mixBuffer = (o: {
  duration: number
  sampleRate: number
  channels: 1 | 2
  start?: number
}): MixBuffer => {
  const n = Math.ceil(o.duration * o.sampleRate)
  return {
    sampleRate: o.sampleRate,
    start: o.start ?? 0,
    channels: Array.from({ length: o.channels }, () => new Float32Array(n)),
  }
}

/**
 * Adds mono `samples` to the buffer, the first at film time `at` (rounded to the nearest sample),
 * times `gain`. `pan` runs from -1 (left) to 1 (right) at constant power: each side
 * sqrt((1 ∓ pan) / 2), so -3 dB each at 0 and the whole gain on one side at ±1. A mono buffer
 * takes the gain alone. Samples before or after the buffer are dropped.
 */
export const add = (
  buf: MixBuffer,
  samples: ArrayLike<number>,
  at: number,
  o: { gain: number; pan: number },
) => {
  if (!(o.pan >= -1 && o.pan <= 1)) throw new RangeError(`pan ${o.pan} is outside [-1, 1]`)
  const gains =
    buf.channels.length === 1
      ? [o.gain]
      : [o.gain * Math.sqrt((1 - o.pan) / 2), o.gain * Math.sqrt((1 + o.pan) / 2)]
  const s0 = Math.round(at * buf.sampleRate) - Math.round(buf.start * buf.sampleRate)
  buf.channels.forEach((ch, c) => {
    const g = gains[c] as number
    const end = Math.min(samples.length, ch.length - s0)
    for (let j = Math.max(0, -s0); j < end; j++)
      ch[s0 + j] = (ch[s0 + j] as number) + g * (samples[j] as number)
  })
}

/**
 * Deterministic white noise: a function giving the next value in [-1, 1) on each call, the same
 * run for the same seed (motion-random's stream). Make it in open or audio(), never in render.
 */
export const noise = (seed: number) => {
  const next = stream(seed)
  return () => next() * 2 - 1
}

/**
 * The numbers to look at before the mix plays: the peak (largest finite |sample|, all channels),
 * how many samples are NaN or ±Infinity, and each channel's DC offset (the mean of its finite
 * samples). It fixes nothing.
 */
export const check = (buf: MixBuffer) => {
  let peak = 0
  let nonFinite = 0
  const dc = buf.channels.map((ch) => {
    let sum = 0
    let n = 0
    for (const v of ch) {
      if (!Number.isFinite(v)) {
        nonFinite++
        continue
      }
      peak = Math.max(peak, Math.abs(v))
      sum += v
      n++
    }
    return n === 0 ? 0 : sum / n
  })
  return { peak, nonFinite, dc }
}

/** Core's Pcm, to return from audio() as `{ pcm: toPcm(buf), at: buf.start }`. */
export const toPcm = (buf: MixBuffer): Pcm => ({
  sampleRate: buf.sampleRate,
  channels: buf.channels,
})
