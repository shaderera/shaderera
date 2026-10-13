// render-image-textures: sixteen artworks made in code as PNG bytes
// (preview/art.ts), decoded by the item's pure-JS decoder and packed by its atlas
// into one texture, then drawn as 40 three.js cards (render-three-host) that all sample that one
// texture. The cards fly in a ring, fold flat into the atlas itself (each card in its own cell, at
// its own proportions), burst into a tumbling cloud and close into the ring again. A red tracking
// box follows one card with its atlas rect. Big words name the step (house.ts).

import type { Host } from '@shaderera/core'
import * as THREE from 'three/webgpu'
import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { createThreeHost, threeCamera } from '../../previews/src/three/host.ts'
import { loadAtlas } from '../../previews/src/three/images.ts'
import { makeArt } from './art.ts'

const TAU = Math.PI * 2
const CARDS = 40
const COLUMNS = 4
/** The atlas sheet's side in world units. */
const SHEET = 4.6
const HERO = 5

/** The formations over the loop: when each is reached (s) and held until the next starts. */
const PHASES = [
  { at: 0, hold: 1.0, form: 'ring' },
  { at: 1.8, hold: 2.8, form: 'atlas' },
  { at: 3.5, hold: 4.6, form: 'cloud' },
] as const

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * c * (c * (c * 6 - 15) + 10)
}
const rnd = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453
  return x - Math.floor(x)
}

const renderImageTextures: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-image-textures has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const three = await createThreeHost(host)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)

  // The artworks as PNG files' bytes, read by the item as if from disk.
  const art = makeArt((w, h) => host.io.canvas(w, h))
  const files = new Map(art.map((a) => [a.path, a.bytes]))
  const reader = {
    ...host,
    io: {
      ...host.io,
      read: async (path: string) => {
        const bytes = files.get(path)
        if (!bytes) throw new Error(`No artwork ${path}`)
        return bytes
      },
    },
  } as Host
  const atlas = await loadAtlas(
    reader,
    art.map((a) => a.path),
    { cell: 512, columns: COLUMNS },
  )
  const bytes = art.reduce((s, a) => s + a.bytes.length, 0)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  const material = new THREE.MeshBasicNodeMaterial({ map: atlas.texture, side: THREE.DoubleSide })
  const cell = SHEET / COLUMNS
  const cards = Array.from({ length: CARDS }, (_, i) => {
    const img = i % art.length
    const rect = atlas.rects[img] ?? { rect: [0, 0, 1, 1] as const, aspect: 1 }
    const [u, v, w, h] = rect.rect
    // The card's size: the image fitted in its atlas cell, as the atlas packed it.
    const cw = rect.aspect >= 1 ? cell : cell * rect.aspect
    const ch = rect.aspect >= 1 ? cell / rect.aspect : cell
    const geometry = new THREE.PlaneGeometry(cw, ch)
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let k = 0; k < uv.count; k++) uv.setXY(k, u + uv.getX(k) * w, v + uv.getY(k) * h)
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)
    const col = img % COLUMNS
    const row = Math.floor(img / COLUMNS)
    return {
      mesh,
      img,
      w: cw,
      h: ch,
      rect: rect.rect,
      // The card's place in each formation.
      atlas: new THREE.Vector3(
        (col - 1.5) * cell,
        (1.5 - row) * cell + 0.15,
        i >= art.length ? -0.02 * (i / art.length) : 0,
      ),
      angle: (i / CARDS) * TAU,
      lift: (rnd(i, 1) - 0.5) * 1.6,
      cloud: new THREE.Vector3(
        (rnd(i, 2) - 0.5) * 7,
        (rnd(i, 3) - 0.5) * 4.5,
        (rnd(i, 4) - 0.5) * 6,
      ),
      spin: new THREE.Vector3(rnd(i, 5), rnd(i, 6), rnd(i, 7)).normalize(),
      delay: rnd(i, 8) * 0.35,
    }
  })
  const camera = threeCamera(width / height, 40)
  const q = new THREE.Quaternion()
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()
  const pa = new THREE.Vector3()
  const pb = new THREE.Vector3()

  /** A card's place and turn in a formation at t. */
  const placeIn = (
    form: string,
    c: (typeof cards)[number],
    t: number,
    p: THREE.Vector3,
    r: THREE.Quaternion,
  ) => {
    const ph = t / duration
    if (form === 'ring') {
      const a = c.angle + ph * TAU
      p.set(
        Math.sin(a) * 3.9,
        c.lift + 0.15 + 0.25 * Math.sin(a * 2 + ph * TAU * 2),
        Math.cos(a) * 3.9,
      )
      r.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a)
    } else if (form === 'atlas') {
      p.copy(c.atlas)
      p.z += 0.12 * Math.sin(c.atlas.x * 1.5 + c.atlas.y + ph * TAU * 3)
      r.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.08 * Math.sin(c.atlas.x + ph * TAU * 2))
    } else {
      const k = ph * TAU
      p.set(
        c.cloud.x + 0.4 * Math.sin(k * 2 + c.angle),
        c.cloud.y + 0.4 * Math.cos(k + c.angle * 2),
        c.cloud.z,
      )
      r.setFromAxisAngle(c.spin, k * 2 + c.angle * 3)
    }
  }

  /** The formation the cards are leaving, the one they go to, and the share of the way. */
  const phaseAt = (t: number) => {
    for (let k = 0; k < PHASES.length; k++) {
      const a = PHASES[k] as (typeof PHASES)[number]
      const b = PHASES[(k + 1) % PHASES.length] as (typeof PHASES)[number]
      const next = k + 1 < PHASES.length ? b.at : duration
      if (t >= a.at && t < next) {
        return { from: a.form, to: b.form, start: a.hold, end: next }
      }
    }
    return { from: 'ring', to: 'ring', start: duration, end: duration }
  }

  const words: Word[] = [
    { from: 0, to: 1.8, text: 'DECODE' },
    { from: 1.8, to: 3.5, text: 'ATLAS' },
    { from: 3.5, to: 6, text: 'CARDS' },
  ]
  const counts: Word[] = [
    { from: 0, to: 1.8, text: '16 PNG' },
    { from: 1.8, to: 3.5, text: '1 TEXTURE' },
    { from: 3.5, to: 6, text: '40 CARDS' },
  ]
  const NOTES = [
    'decoded in JavaScript: the same pixels in Node and the browser',
    'sixteen images in one texture, each at its own proportions',
    'every card samples the one atlas, its colours untouched',
  ]

  return {
    async render(t, o) {
      const ph = phaseAt(t)
      for (const c of cards) {
        const u = smooth((t - ph.start - c.delay) / Math.max(0.2, ph.end - ph.start - 0.35))
        placeIn(ph.from, c, t, pa, qa)
        placeIn(ph.to, c, t, pb, qb)
        c.mesh.position.lerpVectors(pa, pb, u)
        // The path between formations bows towards the camera.
        c.mesh.position.z += Math.sin(u * Math.PI) * 1.2
        q.slerpQuaternions(qa, qb, u)
        c.mesh.quaternion.copy(q)
      }
      const k = (t / duration) * TAU
      camera.position.set(
        Math.sin(k) * 2.6,
        1.2 + 0.7 * Math.sin(k * 2),
        8.6 - 1.4 * Math.sin(k * 2 + 1),
      )
      camera.setViewOffset(1000, 1000, 0, 82, 1000, 1000)
      camera.lookAt(0, 0.1, 0)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
      const layer = await three.render(scene, camera, t, o)

      ctx.clearRect(0, 0, width, height)
      theme.wash(width)
      theme.index()
      // The tracking box: one card's corners projected to the frame, with its atlas rect.
      const hero = cards[HERO]
      if (hero) {
        hero.mesh.updateMatrixWorld()
        const pts = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([sx, sy]) => {
          const v = new THREE.Vector3(((sx ?? 0) * hero.w) / 2, ((sy ?? 0) * hero.h) / 2, 0)
          v.applyMatrix4(hero.mesh.matrixWorld).project(camera)
          return [(v.x + 1) * 0.5 * width, (1 - v.y) * 0.5 * height] as const
        })
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        const x0 = Math.min(...xs)
        const y0 = Math.min(...ys)
        const x1 = Math.max(...xs)
        const y1 = Math.max(...ys)
        if (x1 > 0 && x0 < width && y1 > 150 && y0 < 780) {
          ctx.strokeStyle = RED
          ctx.lineWidth = 2
          ctx.strokeRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12)
          const r = hero.rect.map((v) => v.toFixed(3)).join(' ')
          const label = `IMG ${String(hero.img + 1).padStart(2, '0')}  RECT ${r}`
          ctx.font = `14px "${FONT.mono}"`
          ctx.textAlign = 'left'
          ctx.fillStyle = RED
          ctx.fillRect(x0 - 6, y0 - 26, ctx.measureText(label).width + 12, 20)
          ctx.fillStyle = '#000'
          ctx.fillText(label, x0, y0 - 11)
        }
      }
      theme.words(words, counts, t, o.frame)
      const step = words.findIndex((w) => t >= w.from && t < w.to)
      theme.note(NOTES[Math.max(0, step)] ?? '', 1032, 800)
      theme.hud(
        t,
        o.frame,
        `ATLAS ${COLUMNS * 512}×${COLUMNS * 512}   ${(bytes / 1024).toFixed(0)} KB OF PNG`,
        `${ph.from.toUpperCase()} > ${ph.to.toUpperCase()}`,
      )
      return [layer, { color: canvas, name: 'overlay' }]
    },
    status(t) {
      const step = words.findIndex((w) => t >= w.from && t < w.to)
      return `${String(step + 1).padStart(2, '0')}/03  ${(words[step]?.text ?? '').toLowerCase()}`
    },
    inspect(t) {
      const ph = phaseAt(t)
      return { id: 'cards', from: ph.from, to: ph.to, cards: CARDS, images: art.length }
    },
  }
}

export default renderImageTextures
