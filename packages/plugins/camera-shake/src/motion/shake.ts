// A camera that breathes, is handheld, or takes a hit: smooth seeded noise and an envelope, both
// formulas of t, so any frame renders the same at any time (no Math.random, no decay stepped per
// frame). It turns the camera in its own space after it has looked at its target, so the shot's
// target stays what was authored.

import type { Shot } from './camera.ts'

type V3 = readonly [number, number, number]

const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}

/** Smooth 1D gradient noise in about [-1, 1], fixed for a seed. */
export const noise1 = (x: number, seed = 0) => {
  const i = Math.floor(x)
  const f = x - i
  const g = (k: number) => (hash(k * 7919 + seed * 104729) / 4294967296) * 2 - 1
  const a = g(i) * f
  const b = g(i + 1) * (f - 1)
  const u = f * f * f * (f * (f * 6 - 15) + 10)
  return 2 * (a + (b - a) * u)
}

/** Two octaves of noise, for a less mechanical wander. */
const wander = (x: number, seed: number) =>
  noise1(x, seed) * 0.75 + noise1(x * 2.13 + 17.7, seed + 11) * 0.25

export type ShakeStyle = {
  /** Largest turn, in degrees (yaw and pitch; roll is a third of it). */
  degrees: number
  /** How fast it wanders, in cycles per second. */
  frequency: number
  /** Sideways and vertical drift of the eye, in world units. */
  drift?: number
}

/** Presets, from a camera on a tripod that is still alive to a camera that takes a hit. */
export const SHAKE = {
  breathe: { degrees: 0.12, frequency: 0.22, drift: 0.01 },
  'handheld-mild': { degrees: 0.35, frequency: 0.7, drift: 0.02 },
  handheld: { degrees: 0.9, frequency: 1.3, drift: 0.04 },
  impact: { degrees: 2.8, frequency: 11, drift: 0.06 },
} as const satisfies { [name: string]: ShakeStyle }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2])
  return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * The shot shaken at t. `amount` scales it (motion-eases' `envelope` of the hits, or 1 for a
 * steady handheld); `seed` gives each camera its own wander.
 */
export const shake = (
  s: Shot,
  t: number,
  style: ShakeStyle = SHAKE.breathe,
  amount = 1,
  seed = 1,
): Shot => {
  if (amount <= 0) return s
  const deg = (style.degrees * Math.PI) / 180
  const x = t * style.frequency
  const yaw = wander(x, seed) * deg * amount
  const pitch = wander(x, seed + 1) * deg * amount
  const roll = (wander(x, seed + 2) * deg * amount) / 3
  const toTarget = sub(s.target, s.eye)
  const d = Math.hypot(...toTarget)
  const f = norm(toTarget)
  const right = norm(cross(f, [0, 1, 0]))
  const up = cross(right, f)
  // Turn the line of sight by yaw and pitch (small angles), keeping its length.
  const dir = norm(add(add(f, scale(right, Math.tan(yaw))), scale(up, Math.tan(pitch))))
  const drift = (style.drift ?? 0) * amount
  const eye = add(
    add(s.eye, scale(right, wander(x * 0.5, seed + 3) * drift)),
    scale(up, wander(x * 0.5, seed + 4) * drift),
  )
  return { ...s, eye, target: add(eye, scale(dir, d)), roll: s.roll + roll }
}
