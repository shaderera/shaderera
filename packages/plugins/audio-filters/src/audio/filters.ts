// Filters and pitch for sound made in code (a clip's `pcm`): a one-pole low-pass, the biquads of
// the RBJ Audio EQ Cookbook, a MIDI note's frequency and a fade that ends a buffer at zero. Each
// works in place on a Float32Array and returns it; a filter starts from silence and keeps its
// state across the whole array, so filter a note or a bed in one call, not block by block.

/** The biquads, by the cookbook's names. `peak` and the shelves take a gain; the others do not. */
export type Biquad =
  | { type: 'lowpass' | 'highpass' | 'bandpass' | 'notch'; freq: number; q: number }
  | { type: 'peak' | 'lowshelf' | 'highshelf'; freq: number; q: number; gainDb: number }

/** Refuses a sample rate that is not positive, and a frequency outside (0, Nyquist). */
const checkFreq = (what: string, freq: number, sampleRate: number) => {
  if (!(sampleRate > 0 && Number.isFinite(sampleRate)))
    throw new Error(`sampleRate must be a positive number of Hz, got ${sampleRate}`)
  const nyquist = sampleRate / 2
  if (!(freq > 0 && freq < nyquist))
    throw new Error(
      `${what} must be above 0 and below Nyquist (${nyquist} Hz at ${sampleRate} Hz), got ${freq}`,
    )
}

/**
 * A one-pole low-pass at `cutoffHz`, in place: y += a·(x − y), with `a` set so the gain at the
 * cutoff is exactly −3 dB at any cutoff below Nyquist (1 − exp(−2π·fc/sr) is the same at low
 * cutoffs and drifts above a few kHz). 6 dB an octave.
 */
export const onePole = (x: Float32Array, cutoffHz: number, sampleRate: number) => {
  checkFreq('cutoffHz', cutoffHz, sampleRate)
  const c = Math.cos((2 * Math.PI * cutoffHz) / sampleRate)
  const a = c - 1 + Math.sqrt(c * c - 4 * c + 3)
  let y = 0
  for (let i = 0; i < x.length; i++) {
    y += a * ((x[i] as number) - y)
    x[i] = y
  }
  return x
}

/**
 * A biquad from the RBJ Audio EQ Cookbook, in place. `freq` is the cutoff, centre or shelf
 * midpoint in Hz; `q` the cookbook's Q (1/√2 for a flat low-pass or high-pass, −3 dB at `freq`;
 * also 1/√2 for a shelf with slope 1); `gainDb` the gain at the centre of `peak` and of the shelved
 * side of a shelf. `bandpass` peaks at 0 dB.
 */
export const biquad = (x: Float32Array, filter: Biquad, sampleRate: number) => {
  const { type, freq, q } = filter
  checkFreq(`${type} freq`, freq, sampleRate)
  if (!(q > 0 && Number.isFinite(q))) throw new Error(`${type} q must be above 0, got ${q}`)
  const gained = type === 'peak' || type === 'lowshelf' || type === 'highshelf'
  const gainDb = (filter as { gainDb?: number }).gainDb
  if (gained && !Number.isFinite(gainDb))
    throw new Error(`${type} needs gainDb, a finite number of dB, got ${gainDb}`)
  if (!gained && gainDb !== undefined) throw new Error(`${type} takes no gainDb`)

  const w = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const A = 10 ** ((gainDb ?? 0) / 40)
  const s = 2 * Math.sqrt(A) * alpha
  // [b0, b1, b2, a0, a1, a2]
  const k: Record<Biquad['type'], number[]> = {
    lowpass: [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha],
    highpass: [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha],
    bandpass: [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha],
    notch: [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha],
    peak: [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A],
    lowshelf: [
      A * (A + 1 - (A - 1) * cos + s),
      2 * A * (A - 1 - (A + 1) * cos),
      A * (A + 1 - (A - 1) * cos - s),
      A + 1 + (A - 1) * cos + s,
      -2 * (A - 1 + (A + 1) * cos),
      A + 1 + (A - 1) * cos - s,
    ],
    highshelf: [
      A * (A + 1 + (A - 1) * cos + s),
      -2 * A * (A - 1 + (A + 1) * cos),
      A * (A + 1 + (A - 1) * cos - s),
      A + 1 - (A - 1) * cos + s,
      2 * (A - 1 - (A + 1) * cos),
      A + 1 - (A - 1) * cos - s,
    ],
  }
  const [b0, b1, b2, a0, a1, a2] = k[type] as [number, number, number, number, number, number]
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number
    const y = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1
    x1 = v
    y2 = y1
    y1 = y
    x[i] = y
  }
  return x
}

/** The equal-tempered frequency of a MIDI note, A4 (69) at 440 Hz. */
export const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

/**
 * A linear fade over the last `seconds` of a buffer, in place, so its last sample is exactly 0
 * and a cut tail does not click. A buffer shorter than the fade fades over its whole length.
 */
export const tailFade = (x: Float32Array, seconds: number, sampleRate: number) => {
  if (!(sampleRate > 0 && Number.isFinite(sampleRate)))
    throw new Error(`sampleRate must be a positive number of Hz, got ${sampleRate}`)
  if (!(seconds > 0 && Number.isFinite(seconds)))
    throw new Error(`tailFade seconds must be above 0, got ${seconds}`)
  const n = Math.min(x.length, Math.max(1, Math.round(seconds * sampleRate)))
  for (let i = 0; i < n; i++) x[x.length - 1 - i] = (x[x.length - 1 - i] as number) * (i / n)
  return x
}
