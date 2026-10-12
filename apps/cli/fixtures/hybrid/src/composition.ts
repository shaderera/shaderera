import type { Matrices, Open } from '@shaderera/core'
import * as THREE from 'three/webgpu'

/**
 * Fixture: a flat stack of two layers. "World" is three.js (WebGPURenderer on host.gpu, read back
 * as bytes) with an object and world-space text on a plane, depth-tested in the same pass; the
 * text is drawn with io.canvas and uploaded as a DataTexture, which works in the browser Worker
 * and in Node. "Screen" is Canvas2D: a title on an opaque lower-third plate. Only the world layer
 * reads the camera, so an override moves the world and never the screen layer.
 */

const FONTS = [
  ['src/assets/fonts/NotoSans-Bold.ttf', 'Noto Sans Bold'],
  ['src/assets/fonts/NotoSansThai-Bold.ttf', 'Noto Sans Thai Bold'],
] as const

const object = {
  id: 'object',
  space: 'world',
  color: '#e4572e',
  size: 1.2,
  position: [0.8, 1.2, 0],
}

const floor = { id: 'floor', space: 'world', color: '#c9c3b8', size: 12, position: [0, 0, 0] }

/** World text: a plane `width` units wide; its texture is drawn once in open. */
const sign = {
  id: 'sign',
  space: 'world',
  text: 'WORLD · โลก',
  color: '#1d2a4a',
  width: 4,
  position: [-0.6, 1.3, -0.9],
}

const plate = { id: 'plate', space: 'screen', color: '#16181c', x: 0, y: 820, w: 1920, h: 180 }

const title = {
  id: 'title',
  space: 'screen',
  text: 'Hybrid fixture · ไฮบริด',
  x: 120,
  y: 935,
  size: 72,
  color: '#f4f1ea',
}

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

const spin = (t: number) => t * 0.5

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

const open: Open = async ({ manifest, io, gpu }) => {
  if (!gpu) throw new Error('hybrid needs WebGPU: install `webgpu` in Node.')
  for (const [path, family] of FONTS) await io.font(path, family)
  const { width, height } = manifest
  const g = globalThis as { self?: unknown; requestAnimationFrame?: unknown }
  g.self ??= globalThis
  g.requestAnimationFrame ??= () => 0
  const stand = { width, height, style: {}, addEventListener() {}, removeEventListener() {} }
  const renderer = new THREE.WebGPURenderer({ device: gpu, canvas: stand as never })
  await renderer.init()
  const target = new THREE.RenderTarget(width, height)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#e9e6e1')
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(object.size, object.size, object.size),
    new THREE.MeshStandardMaterial({ color: object.color }),
  )
  mesh.name = object.id
  mesh.position.set(...(object.position as V3))
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(floor.size, floor.size),
    new THREE.MeshStandardMaterial({ color: floor.color }),
  )
  ground.name = floor.id
  ground.rotation.x = -Math.PI / 2

  // The sign's texture: Canvas2D text, read back with getImageData into a DataTexture. Drawn
  // upside down because a DataTexture's first row is the bottom of the plane (v = 0).
  const tw = 1024
  const th = 256
  const tc = io.canvas(tw, th)
  const tx = tc.getContext('2d') as OffscreenCanvasRenderingContext2D
  tx.fillStyle = '#ffffff'
  tx.fillRect(0, 0, tw, th)
  tx.translate(0, th)
  tx.scale(1, -1)
  tx.fillStyle = sign.color
  tx.font = '120px "Noto Sans Bold", "Noto Sans Thai Bold"'
  tx.textAlign = 'center'
  tx.textBaseline = 'middle'
  tx.fillText(sign.text, tw / 2, th / 2)
  const texture = new THREE.DataTexture(
    new Uint8Array(tx.getImageData(0, 0, tw, th).data.buffer),
    tw,
    th,
    THREE.RGBAFormat,
  )
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(sign.width, (sign.width * th) / tw),
    new THREE.MeshBasicMaterial({ map: texture }),
  )
  board.name = sign.id
  board.position.set(...(sign.position as V3))

  scene.add(mesh, ground, board)
  const key = new THREE.DirectionalLight('#fff4e0', 3)
  key.position.set(4, 6, 3)
  scene.add(key, new THREE.HemisphereLight('#bcd4ff', '#5a4a3a', 1.2))
  const pickable = [mesh, board, ground]

  const own = new THREE.PerspectiveCamera(35, width / height, 0.1, 100)
  own.coordinateSystem = THREE.WebGPUCoordinateSystem
  const free = new THREE.PerspectiveCamera()
  free.coordinateSystem = THREE.WebGPUCoordinateSystem
  free.matrixAutoUpdate = free.matrixWorldAutoUpdate = false
  let overridden = false

  const place = (t: number) => {
    mesh.rotation.y = spin(t)
    scene.updateMatrixWorld(true)
    const p = pose(t)
    own.position.set(...p.eye)
    own.lookAt(...p.target)
    own.fov = p.fov
    own.updateProjectionMatrix()
    own.updateMatrixWorld(true)
    return overridden ? free : own
  }

  // The screen layer: transparent canvas, opaque plate, title. Never reads the camera.
  const screen = io.canvas(width, height)
  const sx = screen.getContext('2d') as OffscreenCanvasRenderingContext2D
  sx.font = `${title.size}px "Noto Sans Bold", "Noto Sans Thai Bold"`
  const m = sx.measureText(title.text)
  const titleBox = [
    title.x,
    title.y - m.actualBoundingBoxAscent,
    m.width,
    m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
  ].map(round)
  const plateBox = [plate.x, plate.y, plate.w, plate.h]
  const slide = (t: number) => round((1 - ease(t / 0.8)) * -60)

  return {
    async render(t) {
      renderer.setRenderTarget(target)
      renderer.render(scene, place(t))
      const color = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)
      sx.clearRect(0, 0, width, height)
      sx.fillStyle = plate.color
      sx.fillRect(plate.x, plate.y, plate.w, plate.h)
      sx.fillStyle = title.color
      sx.font = `${title.size}px "Noto Sans Bold", "Noto Sans Thai Bold"`
      sx.fillText(title.text, title.x + slide(t), title.y)
      return [
        { color: unpad(color, width, height), alpha: 'opaque', name: 'World' },
        { color: screen, name: 'Screen' },
      ]
    },
    async inspect(t) {
      place(t)
      const p = pose(t)
      const dx = slide(t)
      return {
        world: [
          { ...object, rotation: [0, round(spin(t)), 0] },
          { ...floor, position: [...floor.position] },
          { ...sign, position: [...sign.position] },
        ],
        screen: [
          { ...plate, box: plateBox },
          { ...title, box: [round((titleBox[0] as number) + dx), ...titleBox.slice(1)] },
        ],
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
      // Top layer first: the screen boxes (title above plate), then the world.
      const dx = slide(t)
      const boxes = [
        { id: title.id, box: [(titleBox[0] as number) + dx, ...titleBox.slice(1)] },
        { id: plate.id, box: plateBox },
      ]
      const inside = boxes.find(
        ({ box: [bx, by, bw, bh] }) => x >= bx! && x <= bx! + bw! && y >= by! && y <= by! + bh!,
      )
      if (inside) return { ['id']: inside.id }
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), place(t))
      const hit = ray.intersectObjects(pickable)[0]
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
      override(mat) {
        overridden = mat !== null
        if (!mat) return
        free.matrixWorldInverse.fromArray(mat.view)
        free.matrixWorld.copy(free.matrixWorldInverse).invert()
        free.matrix.copy(free.matrixWorld)
        free.projectionMatrix.fromArray(mat.projection)
        free.projectionMatrixInverse.copy(free.projectionMatrix).invert()
      },
    },
    dispose() {
      texture.dispose()
      target.dispose()
      renderer.dispose()
    },
  }
}

export default open
