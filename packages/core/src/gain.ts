import type { AudioClip, GainCurve, SampledClip } from './protocol.ts'

/** How often a host samples a function gain: every millisecond. */
const GAIN_RATE = 1000

/**
 * The clips as a host passes them on: each function gain sampled every 1/`rate` s over
 * [0, duration] of the composition. A sample that is not a finite number is refused, naming the
 * clip and the time.
 */
export const sampleClips = (
  clips: readonly AudioClip[],
  duration: number,
  rate = GAIN_RATE,
): SampledClip[] =>
  clips.map((clip) => {
    const { gain } = clip
    if (typeof gain !== 'function') return clip as SampledClip
    const n = Math.floor(duration * rate) + 1
    const values = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const t = i / rate
      const v = gain(t)
      if (typeof v !== 'number' || !Number.isFinite(v))
        throw new Error(
          `The gain of ${clip.src} returned ${String(v)} at t = ${t}: a number is needed.`,
        )
      values[i] = v
    }
    return { ...clip, gain: { rate, values } }
  })

/** A sampled gain at t, interpolated linearly between samples and held past either end. */
export const gainAt = (curve: GainCurve, t: number): number => {
  const x = t * curve.rate
  const last = curve.values.length - 1
  if (x <= 0) return curve.values[0] ?? 1
  if (x >= last) return curve.values[last] ?? 1
  const i = Math.floor(x)
  const a = curve.values[i] as number
  const b = curve.values[i + 1] as number
  return a + (b - a) * (x - i)
}
