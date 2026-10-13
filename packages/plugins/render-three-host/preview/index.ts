// render-three-host: a three.js scene rendered by the item on the host's GPU, lit like the film on
// black. A pale iridescent blob is displaced by TSL noise, 900 instanced shards orbit it, and a
// wireframe field ripples below; every one of those moves is TSL reading three's node clock, which
// the item sets to t, so the same frame comes out on every render. The camera cuts between four
// moving shots. Big words name what each shot shows (house.ts).

import {
  cos,
  float,
  hash,
  instanceIndex,
  mx_fractal_noise_float,
  normalLocal,
  positionLocal,
  positionWorld,
  sin,
  time,
  vec3,
} from 'three/tsl'
import * as THREE from 'three/webgpu'
import { createHouse, type Word } from '../../previews/src/house.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import { createThreeHost, threeCamera } from '../../previews/src/three/host.ts'

const TAU = Math.PI * 2
const SHARDS = 900
/** The node clock in turns of the loop: one turn per 6 s, so the loop has no seam. */
const turn = (duration: number) => time.mul(TAU / duration)

type Cut = {
  from: number
  word: string
  note: string
  lens: number
  /** The eye at the shot's start and end, and what it looks at. */
  eye: [number, number, number][]
  target: [number, number, number]
}
const CUTS: Cut[] = [
  {
    from: 0,
    word: 'DISPLACE',
    note: 'TSL noise on the node clock, set to t',
    lens: 35,
    eye: [
      [5.5, 1.2, 5.5],
      [2.6, 0.6, 4.2],
    ],
    target: [0, 0.2, 0],
  },
  {
    from: 1.5,
    word: 'IRIDESCENT',
    note: 'physical material, ACES tone mapping',
    lens: 85,
    eye: [
      [-8.6, 2.6, 6],
      [-6.2, 4, 8.2],
    ],
    target: [0, 0.4, 0],
  },
  {
    from: 3,
    word: 'INSTANCED',
    note: '900 shards moved by TSL alone',
    lens: 24,
    eye: [
      [0.5, 7.5, 2.5],
      [-2.5, 6.5, -1.5],
    ],
    target: [0, 0, 0],
  },
  {
    from: 4.5,
    word: 'WIREFRAME',
    note: 'the same pixels on every render, in Node',
    lens: 28,
    eye: [
      [-7, 0.5, -3],
      [-4.2, 0.9, -1.2],
    ],
    target: [0, 0.6, 0],
  },
]

const renderThreeHost: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-three-host has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const three = await createThreeHost(host, {
    toneMapping: THREE.ACESFilmicToneMapping,
    exposure: 1.1,
    // Every material is opaque, so multisampling stays deterministic (see the item's README).
    samples: 4,
  })
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const ph = turn(duration)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  scene.fog = new THREE.FogExp2(0x000000, 0.075)

  // The blob: an icosphere pushed along its normals by fractal noise that drifts round a circle once
  // a loop, swelling and calming twice. Flat shading takes its normals from the displaced surface.
  const blobMat = new THREE.MeshPhysicalNodeMaterial({
    color: 0xf2f0ee,
    roughness: 0.22,
    metalness: 0,
    iridescence: 1,
    iridescenceIOR: 1.6,
    iridescenceThicknessRange: [180, 700],
    clearcoat: 0.6,
    flatShading: true,
  })
  const drift = vec3(sin(ph), cos(ph), sin(ph.mul(2))).mul(0.9)
  const amount = sin(ph.mul(2)).mul(0.17).add(0.3)
  const noise = mx_fractal_noise_float(positionLocal.mul(1.7).add(drift), 3, 2, 0.5)
  blobMat.positionNode = positionLocal.add(normalLocal.mul(noise.mul(amount)))
  const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 56), blobMat)
  blob.position.y = 0.4
  scene.add(blob)

  // The shards: one instanced mesh; each instance's orbit comes from a hash of its index, at a
  // whole number of turns a loop.
  const shardMat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.3,
  })
  const i = float(instanceIndex)
  const h1 = hash(i)
  const h2 = hash(i.add(17.31))
  const h3 = hash(i.add(41.7))
  const h4 = hash(i.add(73.1))
  const radius = h1.pow(0.7).mul(2.6).add(1.6)
  const speed = h3.mul(3).floor().add(1)
  const angle = h2.mul(TAU).add(ph.mul(speed))
  const lift = sin(h4.mul(TAU).add(ph.mul(2)))
    .mul(h1.mul(0.9).add(0.15))
    .add(0.4)
  const spin = ph.mul(speed).add(h4.mul(TAU))
  const local = vec3(
    positionLocal.x.mul(cos(spin)).sub(positionLocal.z.mul(sin(spin))),
    positionLocal.y,
    positionLocal.x.mul(sin(spin)).add(positionLocal.z.mul(cos(spin))),
  )
  shardMat.positionNode = local
    .mul(h4.mul(0.8).add(0.4))
    .add(vec3(cos(angle).mul(radius), lift, sin(angle).mul(radius)))
  const shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.055), shardMat, SHARDS)
  shards.frustumCulled = false
  const identity = new THREE.Matrix4()
  for (let k = 0; k < SHARDS; k++) shards.setMatrixAt(k, identity)
  scene.add(shards)

  // The field: a wireframe plane rippled by two waves, fading into black with distance.
  const fieldMat = new THREE.MeshBasicNodeMaterial({ wireframe: true })
  const p = positionLocal
  const wave = sin(p.x.mul(0.7).add(ph.mul(2)))
    .mul(0.22)
    .add(sin(p.y.mul(0.9).sub(ph.mul(3))).mul(0.14))
  fieldMat.positionNode = vec3(p.x, p.y, wave)
  const fade = positionWorld.xz.length().mul(-0.18).exp()
  fieldMat.colorNode = vec3(1.4).mul(fade)
  const field = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 44, 44), fieldMat)
  field.rotation.x = -Math.PI / 2
  field.position.y = -1.2
  scene.add(field)

  // The light: a white key, peach and lilac rims, a little fill.
  const key = new THREE.DirectionalLight(0xffffff, 3.2)
  key.position.set(3, 5, 4)
  const peach = new THREE.PointLight(0xffb48c, 10, 12)
  peach.position.set(2.5, 2, -4)
  const lilac = new THREE.PointLight(0xb0a0ff, 24, 12)
  lilac.position.set(-3, -0.3, -3.5)
  scene.add(key, peach, lilac, new THREE.HemisphereLight(0x8890a0, 0x000000, 0.35))

  const camera = threeCamera(width / height)
  const cutAt = (t: number) => {
    let k = CUTS.length - 1
    while (k > 0 && t < (CUTS[k] as Cut).from) k--
    const cut = CUTS[k] as Cut
    const to = (CUTS[k + 1]?.from ?? duration) - cut.from
    const u = (t - cut.from) / to
    return { k, cut, u }
  }
  const words: Word[] = CUTS.map((c, k) => ({
    from: c.from,
    to: CUTS[k + 1]?.from ?? duration,
    text: c.word,
  }))
  const brand: Word[] = [{ from: 0, to: duration, text: 'THREE.JS' }]

  return {
    async render(t, o) {
      const { cut, u } = cutAt(t)
      // Each shot keeps moving: the eye glides from its start to its end, easing out.
      const e = 1 - (1 - u) ** 2
      const [a, b] = cut.eye as [[number, number, number], [number, number, number]]
      camera.position.set(
        a[0] + (b[0] - a[0]) * e,
        a[1] + (b[1] - a[1]) * e,
        a[2] + (b[2] - a[2]) * e,
      )
      camera.fov = (2 * Math.atan(35 / (2 * cut.lens)) * 180) / Math.PI
      // The subject sits in the middle of the picture above the caption.
      camera.setViewOffset(1000, 1000, 0, 82, 1000, 1000)
      camera.lookAt(...cut.target)
      camera.updateProjectionMatrix()
      const layer = await three.render(scene, camera, t, o)
      ctx.clearRect(0, 0, width, height)
      theme.wash(width)
      theme.index()
      theme.words(words, brand, t, o.frame)
      theme.note(cut.note, 1032, 800)
      theme.hud(t, o.frame, `NODE CLOCK ${t.toFixed(3)} S = T`, `WEBGPU   ACES   ${cut.lens} MM`)
      return [layer, { color: canvas, name: 'overlay' }]
    },
    status(t) {
      const { k, cut } = cutAt(t)
      return `${String(k + 1).padStart(2, '0')}/04  ${cut.word.toLowerCase()}`
    },
    inspect(t) {
      const { k, cut } = cutAt(t)
      return { id: 'three', cut: k, shot: cut.word, clock: t }
    },
  }
}

export default renderThreeHost
