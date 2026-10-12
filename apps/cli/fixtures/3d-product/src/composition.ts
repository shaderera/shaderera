import type { Matrices, Open } from '@shaderera/core'
import * as THREE from 'three/webgpu'

/**
 * Fixture: three.js primitives on WebGPURenderer (host.gpu) into a render target, read back as
 * bytes. The camera is four stamped key literals in one array, eased between neighbours. inspect
 * returns the parts (world space) and the camera with the two keys bracketing t; pick raycasts
 * through the camera in effect (the override when one is set). Everything is a function of t.
 */

const parts = [
  { id: 'plinth', shape: 'box', size: [2.4, 0.3, 2.4], color: '#2b2f36', position: [0, 0.15, 0] },
  { id: 'body', shape: 'cylinder', size: [0.6, 1.6, 0.6], color: '#c9ccd1', position: [0, 1.1, 0] },
  {
    id: 'cap',
    shape: 'sphere',
    size: [0.45, 0.45, 0.45],
    color: '#e4572e',
    position: [0, 2.15, 0],
  },
  {
    id: 'badge',
    shape: 'box',
    size: [0.5, 0.5, 0.5],
    color: '#4c9f70',
    position: [0.85, 0.55, 0.6],
  },
] as const

const keys = [
  { id: 'k1', at: 0, eye: [0, 3, 9], target: [0, 1, 0], fov: 35 },
  { id: 'k2', at: 2, eye: [5, 2.4, 5.5], target: [0, 1.1, 0], fov: 35 },
  { id: 'k3', at: 4, eye: [-4.5, 1.6, 4.5], target: [0, 1.2, 0], fov: 30 },
  { id: 'k4', at: 6, eye: [-1.5, 4.5, 6], target: [0, 1, 0], fov: 40 },
]

type Key = (typeof keys)[number]
type V3 = [number, number, number]

const ease = (x: number): number => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

const round = (n: number): number => Math.round(n * 1000) / 1000

const spin = (t: number) => t * 0.3

/** The authored camera at t: the bracketing keys and the eased mix between them. */
const pose = (t: number) => {
  let i = 0
  while (i < keys.length - 2 && t >= (keys[i + 1] as Key).at) i++
  const a = keys[i] as Key
  const b = keys[i + 1] as Key
  const k = ease((t - a.at) / (b.at - a.at))
  const mix = (p: readonly number[], q: readonly number[]) =>
    p.map((v, j) => round(v + ((q[j] as number) - v) * k)) as V3
  return {
    a,
    b,
    eye: mix(a.eye, b.eye),
    target: mix(a.target, b.target),
    fov: round(a.fov + (b.fov - a.fov) * k),
  }
}

const geometryOf = (p: (typeof parts)[number]) => {
  const [x, y, z] = p.size
  if (p.shape === 'box') return new THREE.BoxGeometry(x, y, z)
  if (p.shape === 'sphere') return new THREE.SphereGeometry(x, 48, 24)
  return new THREE.CylinderGeometry(x, z, y, 48)
}

/**
 * WebGPU pads each read-back row to 256 bytes, so at a width that is not a multiple of 64 px the
 * buffer is not `width * height * 4` contiguous bytes: copy the rows out without the padding.
 */
const unpad = (pixels: ArrayBufferView, width: number, height: number): Uint8Array => {
  const raw = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  const row = width * 4
  const stride = Math.ceil(row / 256) * 256
  if (stride === row || raw.byteLength < stride * (height - 1) + row)
    return raw.subarray(0, row * height)
  const out = new Uint8Array(row * height)
  for (let y = 0; y < height; y++) out.set(raw.subarray(y * stride, y * stride + row), y * row)
  return out
}

const open: Open = async ({ manifest, gpu }) => {
  if (!gpu) throw new Error('3d-product needs WebGPU: install `webgpu` in Node.')
  const { width, height } = manifest
  // three's animation loop reads `self.requestAnimationFrame`, absent in Node.
  const g = globalThis as { self?: unknown; requestAnimationFrame?: unknown }
  g.self ??= globalThis
  g.requestAnimationFrame ??= () => 0
  const canvas = { width, height, style: {}, addEventListener() {}, removeEventListener() {} }
  const renderer = new THREE.WebGPURenderer({ device: gpu, canvas: canvas as never })
  await renderer.init()
  const target = new THREE.RenderTarget(width, height)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#e9e6e1')
  const turntable = new THREE.Group()
  scene.add(turntable)
  for (const p of parts) {
    const mesh = new THREE.Mesh(geometryOf(p), new THREE.MeshStandardMaterial({ color: p.color }))
    mesh.name = p.id
    mesh.position.set(...(p.position as unknown as V3))
    turntable.add(mesh)
  }
  const key = new THREE.DirectionalLight('#fff4e0', 3)
  key.position.set(4, 6, 3)
  scene.add(key, new THREE.HemisphereLight('#bcd4ff', '#5a4a3a', 1.2))

  const own = new THREE.PerspectiveCamera(35, width / height, 0.1, 100)
  own.coordinateSystem = THREE.WebGPUCoordinateSystem
  const free = new THREE.PerspectiveCamera()
  free.coordinateSystem = THREE.WebGPUCoordinateSystem
  free.matrixAutoUpdate = free.matrixWorldAutoUpdate = false
  let overridden = false

  const place = (t: number) => {
    turntable.rotation.y = spin(t)
    turntable.updateMatrixWorld(true)
    const p = pose(t)
    own.position.set(...p.eye)
    own.lookAt(...p.target)
    own.fov = p.fov
    own.updateProjectionMatrix()
    own.updateMatrixWorld(true)
    return overridden ? free : own
  }

  return {
    async render(t) {
      renderer.setRenderTarget(target)
      renderer.render(scene, place(t))
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)
      return { color: unpad(pixels, width, height), alpha: 'opaque', name: 'Product' }
    },
    async inspect(t) {
      place(t)
      const p = pose(t)
      return {
        parts: parts.map((part) => {
          const mesh = turntable.getObjectByName(part.id) as THREE.Object3D
          return {
            id: part.id,
            source: (part as { source?: string }).source ?? null,
            space: 'world',
            shape: part.shape,
            color: part.color,
            position: mesh.getWorldPosition(new THREE.Vector3()).toArray().map(round),
          }
        }),
        camera: {
          id: 'camera',
          eye: p.eye,
          target: p.target,
          fov: p.fov,
          override: overridden,
          keys: [p.a, p.b].map((k) => ({ ...k, eye: [...k.eye], target: [...k.target] })),
        },
      }
    },
    async pick(t, x, y) {
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), place(t))
      const hit = ray.intersectObjects(turntable.children)[0]
      return hit ? { ['id']: hit.object.name, point: hit.point.toArray().map(round) as V3 } : null
    },
    camera: {
      async get(t): Promise<Matrices> {
        const was = overridden
        overridden = false
        const c = place(t)
        overridden = was
        return {
          view: [...c.matrixWorldInverse.elements],
          projection: [...c.projectionMatrix.elements],
          up: [0, 1, 0],
          units: 1,
        }
      },
      override(m) {
        overridden = m !== null
        if (!m) return
        free.matrixWorldInverse.fromArray(m.view)
        free.matrixWorld.copy(free.matrixWorldInverse).invert()
        free.matrix.copy(free.matrixWorld)
        free.projectionMatrix.fromArray(m.projection)
        free.projectionMatrixInverse.copy(free.projectionMatrix).invert()
      },
    },
    dispose() {
      target.dispose()
      renderer.dispose()
    },
  }
}

export default open
