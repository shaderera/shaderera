// Shaping a 0–1 progress: eases, a clamp, a mix, the progress of t through a span, and an envelope
// over a list of hit times. Pure functions of their numbers, so any t gives the same value at any
// time.

export type Ease = (u: number) => number

const need = (fn: string, name: string, v: unknown) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${fn} needs ${name}, a number`)
}

export const linear: Ease = (u) => u
/** Smoothstep: eases in and out. */
export const smooth: Ease = (u) => u * u * (3 - 2 * u)
/** Quartic out: fast at the start, slow at the end. */
export const strike: Ease = (u) => 1 - (1 - u) ** 4
/** Cubic in: slow at the start, fast at the end. */
export const accel: Ease = (u) => u * u * u
/** Cubic in-out. */
export const glide: Ease = (u) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2)
/** 0 until u reaches 1, then 1. */
export const hold: Ease = (u) => (u < 1 ? 0 : 1)
/** Sine in-out. */
export const sine: Ease = (u) => -(Math.cos(Math.PI * u) - 1) / 2
/** Exponential in-out. */
export const expo: Ease = (u) =>
  u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 2 ** (20 * u - 10) / 2 : (2 - 2 ** (-20 * u + 10)) / 2
/** Circular in-out. */
export const circ: Ease = (u) =>
  u < 0.5 ? (1 - Math.sqrt(1 - (2 * u) ** 2)) / 2 : (Math.sqrt(1 - (-2 * u + 2) ** 2) + 1) / 2
/** Back out: passes 1 by an amount set by `overshoot`, then returns to 1. */
export const back = (overshoot: number): Ease => {
  need('back', 'overshoot', overshoot)
  const c = overshoot + 1
  return (u) => 1 + c * (u - 1) ** 3 + overshoot * (u - 1) ** 2
}
/**
 * A critically damped spring, as a formula of u rather than a step per frame, scaled to reach 1 at
 * u = 1. A larger `stiffness` reaches its end sooner.
 */
export const settle = (stiffness: number): Ease => {
  need('settle', 'stiffness', stiffness)
  const end = 1 - (1 + stiffness) * Math.exp(-stiffness)
  return (u) => (1 - (1 + stiffness * u) * Math.exp(-stiffness * u)) / end
}
/** A CSS cubic-bezier(x1, y1, x2, y2). */
export const bezier = (x1: number, y1: number, x2: number, y2: number): Ease => {
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3
  const slope = (a: number, b: number, s: number) =>
    3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s
  return (u) => {
    if (u <= 0 || u >= 1) return u <= 0 ? 0 : 1
    let s = u
    for (let i = 0; i < 8; i++) {
      const d = slope(x1, x2, s)
      if (Math.abs(d) < 1e-6) break
      s -= (at(x1, x2, s) - u) / d
    }
    if (s >= 0 && s <= 1 && Math.abs(at(x1, x2, s) - u) <= 1e-14) return at(y1, y2, s)
    // Newton stalled, near an upright tangent: bisect s to the last bits, since a small miss in x
    // there is a large one in y.
    let lo = 0
    let hi = 1
    for (let i = 0; i < 60 && hi - lo > 1e-15; i++) {
      s = (lo + hi) / 2
      if (at(x1, x2, s) < u) lo = s
      else hi = s
    }
    return at(y1, y2, (lo + hi) / 2)
  }
}

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** 0 before `start`, 1 after `end`, and `ease` of the linear progress between. */
export const progress = (t: number, start: number, end: number, ease: Ease) => {
  if (typeof ease !== 'function') throw new Error('progress needs an ease: (u) => number')
  return ease(clamp((t - start) / Math.max(end - start, 1e-6)))
}

export type EnvelopeOptions = {
  /** Seconds from 0 up to 1 after each hit, a straight ramp (0: it jumps). */
  attack?: number
  /** The time constant of the fall from 1, in seconds. */
  decay: number
  /**
   * How hits that overlap make one value: 'max' the strongest (the default), 'last' only the
   * latest hit at or before t, 'sum' all of them added.
   */
  combine?: 'max' | 'last' | 'sum'
  /** The most the value may reach (no limit); with 'sum', where many hits close together stop. */
  limit?: number
}

/**
 * The envelope of hits at `times`: 0 before a hit, up to 1 over `attack`, then falling with time
 * constant `decay`.
 */
export const envelope = (t: number, times: readonly number[], o: EnvelopeOptions) => {
  need('envelope', 'decay', o?.decay)
  const attack = o.attack ?? 0
  const decay = o.decay
  const one = (at: number) => {
    const d = t - at
    if (d < 0) return 0
    return d < attack ? d / attack : Math.exp(-(d - attack) / decay)
  }
  let v = 0
  if (o.combine === 'last') {
    let last = Number.NEGATIVE_INFINITY
    for (const x of times) if (x <= t && x > last) last = x
    v = Number.isFinite(last) ? one(last) : 0
  } else if (o.combine === 'sum') v = times.reduce((s, at) => s + one(at), 0)
  else for (const at of times) v = Math.max(v, one(at))
  return Math.min(o.limit ?? Number.POSITIVE_INFINITY, v)
}
