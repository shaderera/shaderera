// The song's grid at render time, from what tools/analyze-music.ts measured. The picture asks the
// clock for every time it uses, so every change lands on the music: clock.at(17) is bar 17's
// downbeat, clock.at(17, 2) its third beat, clock.at(17, 0, 3) its fourth 1/16.

import type { Host } from '@shaderera/core'

/** What tools/analyze-music.ts writes. */
export type Analysis = {
  kind: 'shaderera.analysis/1'
  of: { path: string; sha256: string }
  duration: number
  tempo: {
    bpm: number
    period: number
    phase: number
    downbeatClass: number
    /** How the grid was fitted to the song's strong onsets (fitGrid); absent in older analyses. */
    fit?: { from: number; subdivision: number; onsets: number; residualMs: number }
  }
  beats: number[]
  downbeats: number[]
  onsets: { t: number; strength: number }[]
  silences: { from: number; to: number }[]
  sections: { t: number; novelty: number }[]
  bands: { fps: number; sub: number[]; low: number[]; mid: number[]; high: number[] }
}

const hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Reads an analysis, and refuses it when it was measured from other bytes than `song`: a changed
 * song with an old analysis would cut the picture to a grid the music no longer has.
 */
export const loadAnalysis = async (host: Host, song: string, analysis: string) => {
  const a = JSON.parse(new TextDecoder().decode(await host.io.read(analysis))) as Analysis
  if (a.of.sha256 !== (await hex(await host.io.read(song))))
    throw new Error(
      `${analysis} was measured from other bytes than ${song}; run: node tools/analyze-music.ts ${song} ${analysis}`,
    )
  return a
}

export type Clock = {
  readonly bpm: number
  /** Seconds per beat, per bar and per 1/16. */
  readonly beat: number
  readonly bar: number
  readonly sixteenth: number
  /** When bar 1 starts (it may be negative when the film starts inside the song). */
  readonly first: number
  /** The time of bar n (1-based), plus beats and sixteenths into it. */
  at(bar: number, beat?: number, sixteenth?: number): number
  /** The index of the 1/16 that t falls in (0 at bar 1). */
  sixteenthAt(t: number): number
  /** Seconds since the 1/16 that t falls in began. */
  sinceSixteenth(t: number): number
  /** Where t is, 1-based: bar, beat in the bar, 1/16 in the beat. */
  position(t: number): { bar: number; beat: number; sixteenth: number }
}

/** A clock from a tempo and the time of bar 1. `beatsPerBar` is 4 unless the song says otherwise. */
export const clockOf = (o: { bpm: number; first: number; beatsPerBar?: number }): Clock => {
  const beat = 60 / o.bpm
  const bar = (o.beatsPerBar ?? 4) * beat
  const sixteenth = beat / 4
  const sixteenthAt = (t: number) => Math.floor((t - o.first) / sixteenth)
  return {
    bpm: o.bpm,
    beat,
    bar,
    sixteenth,
    first: o.first,
    at: (n, b = 0, s = 0) => o.first + (n - 1) * bar + b * beat + s * sixteenth,
    sixteenthAt,
    sinceSixteenth: (t) => t - (o.first + sixteenthAt(t) * sixteenth),
    position: (t) => {
      const b = (t - o.first) / bar
      return {
        bar: Math.floor(b) + 1,
        beat: Math.floor((((b % 1) + 1) % 1) * (bar / beat)) + 1,
        sixteenth: Math.floor((((((t - o.first) / beat) % 1) + 1) % 1) * 4) + 1,
      }
    },
  }
}

/**
 * The clock of an analysed song. The song's first measured downbeat is bar `firstBar` (1 unless
 * the song has a pickup you want numbered otherwise). `trim` is how many seconds of the song the
 * film leaves out at its start, so times are film times.
 */
export const clockFromAnalysis = (
  a: Analysis,
  o: { firstBar?: number; trim?: number; beatsPerBar?: number } = {},
): Clock => {
  const bar = (o.beatsPerBar ?? 4) * a.tempo.period
  const down = a.downbeats[0] ?? a.tempo.phase
  return clockOf({
    bpm: a.tempo.bpm,
    first: down - (o.trim ?? 0) - ((o.firstBar ?? 1) - 1) * bar,
    beatsPerBar: o.beatsPerBar,
  })
}

/**
 * The song's four bands at t, each 0–1 over its loudest `range` dB (sub, low, mid, high). `trim`
 * as in clockFromAnalysis.
 */
export const bandsOf = (a: Analysis, o: { range?: number; trim?: number } = {}) => {
  const range = o.range ?? 40
  const level = (x: number | undefined) => Math.min(1, Math.max(0, ((x ?? -range) + range) / range))
  const { fps, sub, low, mid, high } = a.bands
  return (t: number): [sub: number, low: number, mid: number, high: number] => {
    const i = Math.min(sub.length - 1, Math.max(0, Math.round((t + (o.trim ?? 0)) * fps)))
    return [level(sub[i]), level(low[i]), level(mid[i]), level(high[i])]
  }
}

/** The song's onsets at least `strength` strong, in film time. */
export const hitsOf = (a: Analysis, o: { strength?: number; trim?: number } = {}) =>
  a.onsets.filter((x) => x.strength >= (o.strength ?? 0)).map((x) => x.t - (o.trim ?? 0))

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? Number.POSITIVE_INFINITY : (s[Math.floor(s.length / 2)] as number)
}

/**
 * Fits a beat grid to the song's own hits. Autocorrelation finds a tempo only to within its step,
 * and 0.15 BPM off drifts 40 ms in 22 bars. Here every onset at least `strength` strong (the
 * median strength by default) and within `window` steps of the grid gets its step number, and the
 * period and phase become the least-squares line through them, twice. The steps are 1/`subdivision`
 * of a beat. Songs differ in where their hits fall (on beats, eighths or sixteenths), so without
 * one each of 1, 2 and 4 is fitted and the one whose onsets sit closest to it is kept. A fitted
 * grid is kept only when the median distance from its onsets shrinks; `residualMs` is that
 * median. `period` and `phase` are a beat's, in and out.
 */
export const fitGrid = (
  onsets: readonly { t: number; strength: number }[],
  beat: { period: number; phase: number },
  o: { strength?: number; window?: number; rounds?: number; subdivision?: number } = {},
): Fit => {
  if (o.subdivision !== undefined) return fitSteps(onsets, beat, o, o.subdivision)
  const fits = [1, 2, 4].map((sub) => fitSteps(onsets, beat, o, sub))
  const score = (f: Fit) => (Number.isNaN(f.residualMs) ? Number.POSITIVE_INFINITY : f.residualMs)
  return fits.reduce((a, b) =>
    score(b) < score(a) || (score(b) === score(a) && b.onsets > a.onsets) ? b : a,
  )
}

export type Fit = {
  period: number
  phase: number
  /** The steps the grid was fitted on: 1 a beat, 2 eighths, 4 sixteenths. */
  subdivision: number
  onsets: number
  residualMs: number
}

const fitSteps = (
  onsets: readonly { t: number; strength: number }[],
  beat: { period: number; phase: number },
  o: { strength?: number; window?: number; rounds?: number },
  sub: number,
): Fit => {
  const floor = o.strength ?? median(onsets.map((x) => x.strength))
  const strong = onsets.filter((x) => x.strength >= floor).map((x) => x.t)
  const window = o.window ?? 0.25
  const grid = { period: beat.period / sub, phase: beat.phase }
  /** The onsets near `g`, each with its beat number and its distance to the grid. */
  const near = (g: { period: number; phase: number }) =>
    strong.flatMap((t) => {
      const k = Math.round((t - g.phase) / g.period)
      const d = t - (g.phase + k * g.period)
      return Math.abs(d) <= window * g.period ? [{ t, k, d: Math.abs(d) }] : []
    })
  const residual = (g: { period: number; phase: number }, on: { t: number; k: number }[]) =>
    median(on.map((x) => Math.abs(x.t - (g.phase + x.k * g.period))))
  let best = { ...grid }
  let on = near(best)
  let error = residual(best, on)
  for (let round = 0; round < (o.rounds ?? 2); round++) {
    if (on.length < 8) break
    const n = on.length
    const mk = on.reduce((s, x) => s + x.k, 0) / n
    const mt = on.reduce((s, x) => s + x.t, 0) / n
    const skk = on.reduce((s, x) => s + (x.k - mk) ** 2, 0)
    if (skk === 0) break
    const period = on.reduce((s, x) => s + (x.k - mk) * (x.t - mt), 0) / skk
    const fitted = { period, phase: mt - period * mk }
    // Judged on the same onsets, so a fit cannot win by dropping the ones it misses.
    if (!(period > 0) || residual(fitted, on) >= error) break
    best = fitted
    on = near(best)
    error = residual(best, on)
  }
  // Step 0 is a beat (the phase it started from): the phase is the first beat at or after 0.
  const period = best.period * sub
  const phase = best.phase - Math.floor(best.phase / period) * period
  return {
    period,
    phase,
    subdivision: sub,
    onsets: on.length,
    residualMs: Number.isFinite(error) ? error * 1000 : Number.NaN,
  }
}
