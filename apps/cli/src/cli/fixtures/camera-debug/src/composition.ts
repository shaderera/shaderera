import type { Matrices, Open } from '@shaderera/core'
import { mat4, vec3 } from 'wgpu-matrix'

/**
 * A Canvas2D wireframe (a floor grid and a box) seen through its own camera, which it
 * interpolates from a list of keys. One key is wrong on purpose: find it with the debugger.
 */

type Key = { id: string; t: number; eye: number[]; target: number[]; fov: number }

/** A point on a 4 m orbit at height 1.6, `a` radians round. */
const orbit = (a: number, r = 4) => [r * Math.sin(a), 1.6, r * Math.cos(a)]

const keys: Key[] = [
  { id: 'k0', t: 0, eye: orbit(0), target: [0, 0.5, 0], fov: 50 },
  { id: 'k1', t: 1, eye: orbit(0.3), target: [0, 0.5, 0], fov: 50 },
  { id: 'k2', t: 2, eye: orbit(0.6), target: [0, 0.5, 0], fov: 48 },
  { id: 'k3', t: 3, eye: orbit(0.9), target: [0, 0.5, 0], fov: 46 },
  { id: 'k4', t: 4.1, eye: orbit(1.23), target: [0, 0.5, 0], fov: 44 },
  { id: 'k5', t: 4.12, eye: orbit(1.236, 4.4), target: [0, 0.5, 0], fov: 44 },
  { id: 'k6', t: 5, eye: orbit(1.5), target: [0, 0.5, 0], fov: 42 },
  { id: 'k7', t: 6, eye: orbit(1.8), target: [0, 0.5, 0], fov: 40 },
]

const lerp = (a: number, b: number, s: number) => a + (b - a) * s

/** The camera at t: keys interpolated linearly, clamped at both ends. */
const cameraAt = (t: number) => {
  const i = Math.max(
    0,
    keys.findLastIndex((k) => k.t <= t),
  )
  const a = keys[i] as Key
  const b = keys[Math.min(i + 1, keys.length - 1)] as Key
  const s = b === a ? 0 : Math.min(1, (t - a.t) / (b.t - a.t))
  const mix = (p: number[], q: number[]) => p.map((v, j) => lerp(v, q[j] as number, s))
  return {
    id: 'camera',
    eye: mix(a.eye, b.eye),
    target: mix(a.target, b.target),
    fov: lerp(a.fov, b.fov, s),
    between: [a.id, b.id],
  }
}

/** The floor grid and the box, as world-space line segments. */
const lines: number[][][] = []
for (let i = -5; i <= 5; i++)
  lines.push(
    [
      [i, 0, -5],
      [i, 0, 5],
    ],
    [
      [-5, 0, i],
      [5, 0, i],
    ],
  )
const c = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x - 0.5, y, z - 0.5])))
for (const [a, b] of [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as [number, number][])
  lines.push([c[a] as number[], c[b] as number[]])

const open: Open = async ({ manifest, io }) => {
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  let override: Matrices | null = null

  const matricesAt = (t: number): Matrices => {
    const cam = cameraAt(t)
    return {
      view: [...mat4.lookAt(cam.eye, cam.target, [0, 1, 0])],
      projection: [...mat4.perspective((cam.fov * Math.PI) / 180, width / height, 0.1, 100)],
      up: [0, 1, 0],
      units: 1,
    }
  }

  return {
    async render(t) {
      const m = override ?? matricesAt(t)
      const viewProjection = mat4.multiply(m.projection as number[], m.view as number[])
      ctx.fillStyle = '#101418'
      ctx.fillRect(0, 0, width, height)
      ctx.lineWidth = 1.5
      lines.forEach(([a, b], i) => {
        const [px = 0, py = 0, pz = 0] = vec3.transformMat4(a, viewProjection)
        const [qx = 0, qy = 0, qz = 0] = vec3.transformMat4(b, viewProjection)
        if (pz < 0 || pz > 1 || qz < 0 || qz > 1) return
        ctx.strokeStyle = i < 22 ? '#3a4a5a' : '#ffb347'
        ctx.beginPath()
        ctx.moveTo((px * 0.5 + 0.5) * width, (0.5 - py * 0.5) * height)
        ctx.lineTo((qx * 0.5 + 0.5) * width, (0.5 - qy * 0.5) * height)
        ctx.stroke()
      })
      return { color: canvas, name: 'Wireframe' }
    },
    async inspect(t) {
      return { camera: cameraAt(t), keys }
    },
    camera: {
      get: async (t) => matricesAt(t),
      override(m) {
        override = m
      },
    },
  }
}

export default open
