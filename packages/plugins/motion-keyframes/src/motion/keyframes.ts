// Keyframed values over the film's time: a value is held between keys and eased into each key from
// the one before. Everything that moves (a position, a scale, an opacity, a camera) is a track,
// asked for its value at t. No state, so any t renders the same at any time.

export type Ease = (u: number) => number

export const linear: Ease = (u) => u
/** Smoothstep: eases in and out. The default. */
export const smooth: Ease = (u) => u * u * (3 - 2 * u)
/** Fast start, long settle: a hit, a cut, a snap into place. */
export const strike: Ease = (u) => 1 - (1 - u) ** 4
/** Slow start, fast end: a fall, a build into a drop. */
export const accel: Ease = (u) => u * u * u
/** A long, even glide in and out (cubic in-out). */
export const glide: Ease = (u) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2)
/** Holds the old value to the key, then jumps: a cut. */
export const hold: Ease = (u) => (u < 1 ? 0 : 1)
/** Sine in-out: the gentlest start and stop. */
export const sine: Ease = (u) => -(Math.cos(Math.PI * u) - 1) / 2
/** Exponential in-out: still, then fast, then still. */
export const expo: Ease = (u) =>
  u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 2 ** (20 * u - 10) / 2 : (2 - 2 ** (-20 * u + 10)) / 2
/** Circular in-out. */
export const circ: Ease = (u) =>
  u < 0.5 ? (1 - Math.sqrt(1 - (2 * u) ** 2)) / 2 : (Math.sqrt(1 - (-2 * u + 2) ** 2) + 1) / 2
/** Overshoots the key a little, then comes back to it. */
export const back = (overshoot = 1.70158): Ease => {
  const c = overshoot + 1
  return (u) => 1 + c * (u - 1) ** 3 + overshoot * (u - 1) ** 2
}
/**
 * A critically damped spring, as a formula of u rather than a step per frame: the feel of damping
 * with no state. `stiffness` sets how quickly it arrives (8 lands softly, 14 snaps).
 */
export const settle = (stiffness = 8): Ease => {
  const end = 1 - (1 + stiffness) * Math.exp(-stiffness)
  return (u) => (1 - (1 + stiffness * u) * Math.exp(-stiffness * u)) / end
}
/** A CSS-style cubic bezier, (x1, y1, x2, y2), as in a motion designer's curve editor. */
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
    let lo = 0
    let hi = 1
    for (let i = 0; i < 30 && Math.abs(at(x1, x2, s) - u) > 1e-7; i++) {
      if (at(x1, x2, s) < u) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return at(y1, y2, s)
  }
}

/** A key: at time t the value is v, reached from the key before with `ease` (smooth by default). */
export type Key<T> = readonly [t: number, v: T, ease?: Ease]

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** A number over time. Keys must be in time order. */
export const track = (keys: readonly Key<number>[]) => {
  if (keys.length === 0) throw new Error('a track needs at least one key')
  return (t: number): number => {
    const first = keys[0] as Key<number>
    if (t <= first[0]) return first[1]
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, ease = smooth] = keys[i] as Key<number>
      const [t0, v0] = keys[i - 1] as Key<number>
      if (t < t1) return lerp(v0, v1, ease(clamp((t - t0) / Math.max(t1 - t0, 1e-6))))
    }
    return (keys[keys.length - 1] as Key<number>)[1]
  }
}

export type V3 = readonly [number, number, number]

/** A point over time, each axis its own track with the same keys and eases. */
export const track3 = (keys: readonly Key<V3>[]) => {
  const axis = (i: 0 | 1 | 2) => track(keys.map(([t, v, e]) => [t, v[i], e] as Key<number>))
  const x = axis(0)
  const y = axis(1)
  const z = axis(2)
  return (t: number): V3 => [x(t), y(t), z(t)]
}

/**
 * One move through several points that never stops at the ones between: a smooth curve through
 * all of them (centripetal Catmull-Rom, so it neither loops nor overshoots), travelled at an even
 * speed with one ease over the whole span from `from` to `to`. A track stops at every key; a path
 * flows through.
 */
export const path3 = (points: readonly V3[], from: number, to: number, ease: Ease = smooth) => {
  if (points.length === 0) throw new Error('a path needs at least one point')
  const p = (i: number) => points[Math.min(points.length - 1, Math.max(0, i))] as V3
  const dist = (a: V3, b: V3) => Math.max(1e-6, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
  // One segment between p1 and p2 (Barry-Goldman, alpha 0.5).
  const segment = (i: number, s: number): V3 => {
    const p0 = i === 0 ? p(0) : p(i - 1)
    const p1 = p(i)
    const p2 = p(i + 1)
    const p3 = i + 2 >= points.length ? p2 : p(i + 2)
    const t1 = Math.sqrt(dist(p0, p1))
    const t2 = t1 + Math.sqrt(dist(p1, p2))
    const t3 = t2 + Math.sqrt(dist(p2, p3))
    const tt = t1 + (t2 - t1) * s
    const mix = (a: V3, b: V3, ta: number, tb: number): V3 => {
      const w = (tt - ta) / Math.max(tb - ta, 1e-9)
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
    }
    const a1 = mix(p0, p1, 0, t1)
    const a2 = mix(p1, p2, t1, t2)
    const a3 = mix(p2, p3, t2, t3)
    const b1 = mix(a1, a2, 0, t2)
    const b2 = mix(a2, a3, t1, t3)
    return mix(b1, b2, t1, t2)
  }
  const segments = Math.max(1, points.length - 1)
  const N = 64 * segments
  const samples: V3[] = []
  const lengths = [0]
  for (let k = 0; k <= N; k++) {
    const x = (k / N) * segments
    const i = Math.min(segments - 1, Math.floor(x))
    samples.push(points.length === 1 ? p(0) : segment(i, x - i))
    if (k > 0)
      lengths.push((lengths[k - 1] as number) + dist(samples[k - 1] as V3, samples[k] as V3))
  }
  const total = lengths[N] as number
  return (t: number): V3 => {
    const d = ease(clamp((t - from) / Math.max(to - from, 1e-6))) * total
    let lo = 0
    let hi = N
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if ((lengths[mid] as number) < d) lo = mid
      else hi = mid
    }
    const a = samples[lo] as V3
    const b = samples[hi] as V3
    const w =
      (d - (lengths[lo] as number)) /
      Math.max((lengths[hi] as number) - (lengths[lo] as number), 1e-9)
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
  }
}

/** 0 before `from`, 1 after `to`, eased between: a fade, a reveal, a wipe. */
export const progress = (t: number, from: number, to: number, ease: Ease = smooth) =>
  ease(clamp((t - from) / Math.max(to - from, 1e-6)))

/** Whether t is in [a, b). */
export const between = (t: number, a: number, b: number) => t >= a && t < b
