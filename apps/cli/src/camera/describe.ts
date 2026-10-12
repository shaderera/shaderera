import type { Matrices } from '@shaderera/core'
import { mat4, vec3 } from 'wgpu-matrix'

export type CameraDescription = {
  eye: number[]
  forward: number[]
  up: number[]
  /** Vertical field of view in degrees. */
  fovY: number
  aspect: number
  near: number
  far: number
}

/**
 * A camera in words, from its view and perspective projection (column-major, WebGPU clip space
 * with z in [0, 1]). An infinite far plane reads as `Infinity`.
 */
export const describeCamera = (m: Matrices): CameraDescription => {
  const world = mat4.inverse(m.view as number[])
  const p = (i: number) => m.projection[i] ?? 0
  return {
    eye: [...mat4.getTranslation(world)],
    forward: [...vec3.normalize(vec3.negate(mat4.getAxis(world, 2)))],
    up: [...vec3.normalize(mat4.getAxis(world, 1))],
    fovY: (2 * Math.atan(1 / p(5)) * 180) / Math.PI,
    aspect: p(5) / p(0),
    near: p(14) / p(10),
    far: p(10) === -1 ? Infinity : p(14) / (p(10) + 1),
  }
}
