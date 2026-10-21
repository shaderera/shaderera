// A 3D camera as keyframed shots: where it is, what it looks at, its lens, its roll, where the
// subject sits in the frame and where it is focused, moved from shot to shot over the film's time.
// Every value is a formula of t (no damping stepped per frame), so any frame renders the same at
// any time. It gives the matrices for raw WebGPU (clip z 0–1, column-major), sets a three.js
// camera, and speaks core's camera contract. A tall variant opens the lens instead of losing the
// sides of a shot designed for 16:9.

import type { CameraCapability, Matrices } from '@shaderera/core'
import { clamp, type Ease, type Key, lerp, path3, smooth, track, type V3 } from './keyframes.ts'

export type Shot = {
  eye: V3
  target: V3
  /** Vertical field of view in degrees (see `lens` to work in millimetres). */
  fov: number
  /** Turn about the line of sight, in radians. */
  roll: number
  /**
   * Moves the picture without changing perspective, in frame widths and heights: [-1/6, 0] puts a
   * centred subject on the left third. Like a shift lens, or three's setViewOffset.
   */
  shift?: readonly [number, number]
  /** Focus distance from the eye, for depth of field. */
  focus?: number
  /** Aperture, for depth of field: smaller is shallower. */
  fStop?: number
  /**
   * How the camera arrives at this shot from the one before. 'orbit' (the default) swings round
   * the target keeping its distance, then dollies; 'line' moves the eye in a straight line (a
   * fly-by past the subject).
   */
  path?: 'orbit' | 'line'
}

export const shot = (
  eye: V3,
  target: V3 = [0, 0, 0],
  fov = 40,
  roll = 0,
  more: Partial<Shot> = {},
): Shot => ({
  eye,
  target,
  fov,
  roll,
  ...more,
})

/**
 * The vertical field of view (degrees) of a lens of `mm` on 35 mm film, for a frame of `aspect`
 * (16:9 by default): what "a 35 mm lens" or "an 85 mm portrait" means in a prompt.
 */
export const lens = (mm: number, aspect = 16 / 9, gauge = 35) =>
  (2 * Math.atan(gauge / Math.max(aspect, 1) / (2 * mm)) * 180) / Math.PI

/** How much of the frame a subject fills, for `fit`: a wide shot, a medium shot, a close-up. */
export const FILL = { wide: 0.35, medium: 0.6, close: 0.9 } as const

/**
 * A shot that frames a subject (a sphere: `center`, `radius`) from a direction: `azimuth` degrees
 * round the vertical from +z, `elevation` degrees above the horizon. `fill` is how much of the
 * frame's shorter side the subject spans. The distance is exact for the lens and the frame.
 */
export const fit = (o: {
  center: V3
  radius: number
  azimuth?: number
  elevation?: number
  fov?: number
  aspect?: number
  fill?: number
  roll?: number
  shift?: readonly [number, number]
}): Shot => {
  const fov = o.fov ?? lens(35)
  const aspect = o.aspect ?? 16 / 9
  const v = (fov * Math.PI) / 180
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect)
  const half = Math.min(v, h) / 2
  const d = o.radius / Math.sin(half * clamp(o.fill ?? FILL.medium, 0.05, 0.99))
  const az = ((o.azimuth ?? 0) * Math.PI) / 180
  const el = ((o.elevation ?? 10) * Math.PI) / 180
  const eye: V3 = [
    o.center[0] + d * Math.cos(el) * Math.sin(az),
    o.center[1] + d * Math.sin(el),
    o.center[2] + d * Math.cos(el) * Math.cos(az),
  ]
  return { eye, target: o.center, fov, roll: o.roll ?? 0, ...(o.shift ? { shift: o.shift } : {}) }
}

/** The bounding sphere of points or of a box's corners, for `fit`. */
export const bounds = (points: readonly V3[]): { center: V3; radius: number } => {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const p of points)
    for (const i of [0, 1, 2] as const) {
      lo[i] = Math.min(lo[i], p[i])
      hi[i] = Math.max(hi[i], p[i])
    }
  const center: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  let radius = 0
  for (const p of points)
    radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]))
  return { center, radius }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const mix3 = (a: V3, b: V3, u: number): V3 => [
  lerp(a[0], b[0], u),
  lerp(a[1], b[1], u),
  lerp(a[2], b[2], u),
]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: V3): V3 => {
  const l = len(a)
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}

/** The eye's offset from the target, swung on an arc: the shorter way round, distance eased on a log scale. */
const orbit = (a: V3, b: V3, u: number): V3 => {
  const ra = len(a)
  const rb = len(b)
  if (ra < 1e-9 || rb < 1e-9) return mix3(a, b, u)
  const azA = Math.atan2(a[0], a[2])
  const azB = Math.atan2(b[0], b[2])
  const turn = ((((azB - azA + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI
  const az = azA + turn * u
  const pol = lerp(Math.acos(clamp(a[1] / ra, -1, 1)), Math.acos(clamp(b[1] / rb, -1, 1)), u)
  const r = ra * (rb / ra) ** u
  return [r * Math.sin(pol) * Math.sin(az), r * Math.cos(pol), r * Math.sin(pol) * Math.cos(az)]
}

const mixOptional = (a: number | undefined, b: number | undefined, u: number) =>
  a === undefined ? b : b === undefined ? a : lerp(a, b, u)

/** Shot `a` moved toward shot `b` by `u` (0–1), the way `b` says it is reached. */
export const blendShots = (a: Shot, b: Shot, u: number): Shot => {
  const target = mix3(a.target, b.target, u)
  const eye =
    b.path === 'line'
      ? mix3(a.eye, b.eye, u)
      : add(target, orbit(sub(a.eye, a.target), sub(b.eye, b.target), u))
  const shift =
    a.shift || b.shift
      ? ([
          lerp(a.shift?.[0] ?? 0, b.shift?.[0] ?? 0, u),
          lerp(a.shift?.[1] ?? 0, b.shift?.[1] ?? 0, u),
        ] as const)
      : undefined
  const focus = mixOptional(a.focus, b.focus, u)
  const fStop = mixOptional(a.fStop, b.fStop, u)
  return {
    eye,
    target,
    fov: lerp(a.fov, b.fov, u),
    roll: lerp(a.roll, b.roll, u),
    ...(shift ? { shift } : {}),
    ...(focus !== undefined ? { focus } : {}),
    ...(fStop !== undefined ? { fStop } : {}),
  }
}

/**
 * A vertical field of view (radians) designed for a `designed` aspect (16:9), opened for a
 * narrower frame. `opening` 0 keeps the height (and loses the sides), 1 keeps the width (the
 * subject gets small); 0.5, half way on a log scale, keeps a wide shot reading in 9:16. Open it
 * further (0.75) for a shot whose subject spans the width, such as a word. A frame as wide as
 * the design or wider keeps the lens.
 */
export const widenFov = (fov: number, aspect: number, opening = 0.5, designed = 16 / 9) =>
  aspect >= designed ? fov : 2 * Math.atan(Math.tan(fov / 2) * (designed / aspect) ** opening)

export type CameraOptions = {
  /** How far a narrower frame opens the lens: 0 keeps the height, 1 keeps the width (see widenFov). */
  opening?: number | ((t: number) => number)
  /** The aspect the shots were designed for. */
  designed?: number
}

const forFrame = (s: Shot, t: number, aspect: number, o: CameraOptions): Shot => {
  const opening = typeof o.opening === 'function' ? o.opening(t) : (o.opening ?? 0.5)
  return {
    ...s,
    fov: (widenFov((s.fov * Math.PI) / 180, aspect, opening, o.designed) * 180) / Math.PI,
  }
}

/**
 * The camera at any t from shots at times, `[t, shot, ease?]`: held between keys, and moved into
 * each from the one before (smooth by default; `hold` cuts). Each move comes to rest on its key;
 * for one move that flows through several shots, use `cameraPath`.
 */
export const cameraTrack = (keys: readonly Key<Shot>[], o: CameraOptions = {}) => {
  if (keys.length === 0) throw new Error('a camera track needs at least one shot')
  return (t: number, aspect: number): Shot => {
    const first = keys[0] as Key<Shot>
    let s = first[1]
    if (t > first[0]) {
      s = (keys[keys.length - 1] as Key<Shot>)[1]
      for (let i = 1; i < keys.length; i++) {
        const [t1, b, ease = smooth] = keys[i] as Key<Shot>
        const [t0, a] = keys[i - 1] as Key<Shot>
        if (t < t1) {
          s = blendShots(a, b, ease(clamp((t - t0) / Math.max(t1 - t0, 1e-6))))
          break
        }
      }
    }
    return forFrame(s, t, aspect, o)
  }
}

/**
 * One continuous move from `from` to `to` through all the shots, never stopping at the ones
 * between: the eye and the target each travel a smooth curve at an even speed, with one ease over
 * the whole move. Held at the first shot before and the last after.
 */
export const cameraPath = (
  shots: readonly Shot[],
  from: number,
  to: number,
  ease: Ease = smooth,
  o: CameraOptions = {},
) => {
  if (shots.length === 0) throw new Error('a camera path needs at least one shot')
  const eye = path3(
    shots.map((s) => s.eye),
    from,
    to,
    ease,
  )
  const target = path3(
    shots.map((s) => s.target),
    from,
    to,
    ease,
  )
  const at = (i: number) => from + ((to - from) * i) / Math.max(1, shots.length - 1)
  const fov = track(shots.map((s, i) => [at(i), s.fov] as Key<number>))
  const roll = track(shots.map((s, i) => [at(i), s.roll] as Key<number>))
  return (t: number, aspect: number): Shot => {
    const s = { eye: eye(t), target: target(t), fov: fov(t), roll: roll(t) }
    return forFrame(s, t, aspect, o)
  }
}

type M4 = Float32Array

/**
 * The camera's up direction with its roll. Looking straight down, "up" on screen eases to far (−z),
 * so a camera can pass over the top without flipping.
 */
export const upOf = (c: Shot): V3 => {
  const f = norm(sub(c.target, c.eye))
  const k = clamp((Math.abs(f[1]) - 0.85) / 0.13)
  const s = k * k * (3 - 2 * k)
  const right = norm(cross(f, norm([0, 1 - s, -s])))
  const up = cross(right, f)
  return add(scale(up, Math.cos(c.roll)), scale(right, Math.sin(c.roll)))
}

/** The view matrix (world to camera; the camera looks down −z). */
export const viewMatrix = (c: Shot): M4 => {
  const z = norm(sub(c.eye, c.target))
  const x = norm(cross(upOf(c), z))
  const y = cross(z, x)
  // biome-ignore format: a matrix reads as columns
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, c.eye), -dot(y, c.eye), -dot(z, c.eye), 1,
  ])
}

/**
 * The perspective projection for WebGPU (clip z from 0 at `near` to 1 at `far`), with the shot's
 * shift. By default near and far follow the distance to the target, so a close-up and a wide shot
 * both keep depth precision.
 */
export const projectionMatrix = (c: Shot, aspect: number, near?: number, far?: number): M4 => {
  const d = len(sub(c.eye, c.target))
  const n = near ?? Math.max(0.01, d * 0.002)
  const fa = far ?? d * 40 + 200
  const f = 1 / Math.tan((c.fov * Math.PI) / 360)
  const r = 1 / (n - fa)
  const sx = c.shift?.[0] ?? 0
  const sy = c.shift?.[1] ?? 0
  // biome-ignore format: a matrix reads as columns
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    -2 * sx, -2 * sy, fa * r, -1,
    0, 0, n * fa * r, 0,
  ])
}

/** projection × view, column-major, for a uniform buffer. */
export const viewProjection = (c: Shot, aspect: number, near?: number, far?: number): M4 => {
  const p = projectionMatrix(c, aspect, near, far)
  const v = viewMatrix(c)
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += (p[k * 4 + row] as number) * (v[col * 4 + k] as number)
      out[col * 4 + row] = s
    }
  return out
}

/** The shot in core's camera contract: matrices, as every renderer and the CLI/MCP exchange them. */
export const matricesOf = (c: Shot, aspect: number): Matrices => ({
  view: Array.from(viewMatrix(c)),
  projection: Array.from(projectionMatrix(c, aspect)),
  up: upOf(c),
})

/**
 * Core's CameraCapability for a camera: `get` reports what the film looks through at t, `override`
 * lets the host's free camera take over (null gives it back). Set `capability` as the source's
 * `camera`, and render through `through(t, options.camera)`.
 */
export const cameraCapability = (at: (t: number, aspect: number) => Shot, aspect: number) => {
  let override: Matrices | null = null
  const capability: CameraCapability = {
    get: async (t) => override ?? matricesOf(at(t, aspect), aspect),
    override: (m) => {
      override = m
    },
  }
  /** The matrices to render with at t: the host's camera if it passed one, else the film's. */
  const through = (t: number, given?: Matrices): Matrices =>
    given ?? override ?? matricesOf(at(t, aspect), aspect)
  return { capability, through }
}

/** The part of a three.js PerspectiveCamera this sets; three itself is not imported. */
type ThreeCamera = {
  position: { set(x: number, y: number, z: number): unknown }
  up: { set(x: number, y: number, z: number): unknown }
  lookAt(x: number, y: number, z: number): void
  fov: number
  aspect: number
  focus?: number
  setViewOffset?(
    fullWidth: number,
    fullHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void
  clearViewOffset?(): void
  updateProjectionMatrix(): void
}

/** Puts a three.js PerspectiveCamera where the shot says, shift and focus included. */
export const applyToThree = (c: Shot, camera: ThreeCamera, aspect: number) => {
  camera.position.set(...c.eye)
  camera.up.set(...upOf(c))
  camera.lookAt(...c.target)
  camera.fov = c.fov
  camera.aspect = aspect
  if (c.focus !== undefined) camera.focus = c.focus
  const [sx, sy] = c.shift ?? [0, 0]
  const W = 1000 * aspect
  const H = 1000
  if (sx !== 0 || sy !== 0) camera.setViewOffset?.(W, H, -sx * W, sy * H, W, H)
  else camera.clearViewOffset?.()
  camera.updateProjectionMatrix()
}

export type { Ease, Key }
