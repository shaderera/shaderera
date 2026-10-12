import type { Json } from '@shaderera/core'
import { frameTimes } from '@shaderera/core'
import { valueAt } from '../cli/inspect.ts'

/**
 * A timing the author declares in requirements.json (`timing`), checked against inspect: what a
 * value at a path is at a time, or over a window. Nothing is assumed; there is no default set
 * (decision 0011). Paths use inspect's syntax: `a.b`, `a[2]`, `a[id=logo].x`.
 */
export type Timing = {
  path: string
  /** One time, in seconds. */
  at?: number
  /** A window, in seconds: every frame in [from, to] is checked. */
  from?: number
  to?: number
  /** The value there, compared as JSON; numbers within `tolerance`. */
  equals?: Json
  /** A number at least / at most this. */
  min?: number
  max?: number
  /** For `equals` on numbers (and arrays of numbers): how close is equal. 1e-6 by default. */
  tolerance?: number
  /** Over a window: `false` holds still (every frame equals the first), `true` moves somewhere. */
  changes?: boolean
  note?: string
}

export type TimingResult = { timing: Timing; ok: boolean; t: number[]; detail: string }

const close = (a: Json | undefined, b: Json, tolerance: number): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => close(x, b[i] as Json, tolerance))
  return JSON.stringify(a) === JSON.stringify(b)
}

const show = (v: Json | undefined) =>
  v === undefined
    ? 'nothing'
    : typeof v === 'number'
      ? String(Number(v.toFixed(4)))
      : JSON.stringify(v)

/** Checks one value against a timing's equals / min / max; a reason when it fails. */
const against = (v: Json | undefined, t: Timing): string | null => {
  const tolerance = t.tolerance ?? 1e-6
  if (t.equals !== undefined && !close(v, t.equals, tolerance))
    return `${show(v)}, not ${show(t.equals)}`
  if (t.min !== undefined && !(typeof v === 'number' && v >= t.min - tolerance))
    return `${show(v)}, below ${t.min}`
  if (t.max !== undefined && !(typeof v === 'number' && v <= t.max + tolerance))
    return `${show(v)}, above ${t.max}`
  return null
}

/** Throws on a timing that says nothing checkable, naming it. */
export const checkTimings = (timings: readonly Timing[]) => {
  for (const [i, t] of timings.entries()) {
    const when = t.at !== undefined || (t.from !== undefined && t.to !== undefined)
    const what =
      t.equals !== undefined ||
      t.min !== undefined ||
      t.max !== undefined ||
      t.changes !== undefined
    if (typeof t.path !== 'string' || !when || !what)
      throw new Error(
        `requirements.json timing[${i}] needs a path, a time (at, or from and to) and what to check (equals, min, max or changes).`,
      )
    if (t.changes !== undefined && t.at !== undefined)
      throw new Error(
        `requirements.json timing[${i}]: changes is about a window (from, to), not one time.`,
      )
  }
}

/**
 * Evaluates the timings with the source's inspect: an `at` once, a window at every frame (at the
 * manifest's fps), memoised per t across timings.
 */
export const evaluateTimings = async (
  timings: readonly Timing[],
  inspect: (t: number) => Promise<Json>,
  manifest: { fps: number; duration: number },
): Promise<TimingResult[]> => {
  const { fps, duration } = manifest
  checkTimings(timings)
  const seen = new Map<number, Json>()
  const at = async (t: number) => {
    if (!seen.has(t)) seen.set(t, await inspect(t))
    return seen.get(t) as Json
  }
  const results: TimingResult[] = []
  for (const timing of timings) {
    if (timing.at !== undefined) {
      const v = valueAt(await at(timing.at), timing.path)
      const reason = against(v, timing)
      results.push({
        timing,
        ok: reason === null,
        t: [timing.at],
        detail: reason ?? `${show(v)} at ${timing.at} s`,
      })
      continue
    }
    const from = timing.from as number
    const to = timing.to as number
    // Inclusive of `to` when it is a frame, never past the film.
    const times = frameTimes(fps, from, Math.min(to + 1 / fps / 2, duration)).filter(
      (t) => t <= to + 1e-9,
    )
    const bad: { t: number; reason: string }[] = []
    let first: Json | undefined
    let moved = false
    for (const t of times) {
      const v = valueAt(await at(t), timing.path)
      if (t === times[0]) first = v
      else if (!close(v, first as Json, timing.tolerance ?? 1e-6)) moved = true
      const reason = against(v, timing)
      if (reason) bad.push({ t, reason })
      if (timing.changes === false && moved && !bad.some((b) => b.t === t))
        bad.push({ t, reason: `${show(v)}, moved from ${show(first)}` })
    }
    if (timing.changes === true && !moved)
      bad.push({ t: times[0] ?? from, reason: `${show(first)} throughout: it never changes` })
    results.push({
      timing,
      ok: bad.length === 0,
      t: bad.map((b) => b.t),
      detail: bad.length
        ? `${bad.length} of ${times.length} frames: ${bad[0]?.reason} at ${bad[0]?.t} s`
        : `${times.length} frames from ${from} to ${to} s`,
    })
  }
  return results
}

/** One value per frame over [from, to] at a path: a curve, and its speed per second. */
export const track = async (
  inspect: (t: number) => Promise<Json>,
  path: string,
  o: { fps: number; from: number; to: number },
): Promise<{ t: number; value: Json | undefined; speed?: number }[]> => {
  const out: { t: number; value: Json | undefined; speed?: number }[] = []
  const times = frameTimes(o.fps, o.from, o.to)
  let previous: { t: number; value: Json | undefined } | undefined
  for (const t of times) {
    const value = valueAt(await inspect(t), path)
    let speed: number | undefined
    const numbers = (v: Json | undefined) =>
      typeof v === 'number'
        ? [v]
        : Array.isArray(v) && v.every((x) => typeof x === 'number')
          ? (v as number[])
          : undefined
    const a = numbers(previous?.value)
    const b = numbers(value)
    if (previous && a && b && a.length === b.length)
      speed = Math.hypot(...b.map((x, i) => x - (a[i] as number))) / (t - previous.t)
    out.push({ t, value, ...(speed === undefined ? {} : { speed }) })
    previous = { t, value }
  }
  return out
}
