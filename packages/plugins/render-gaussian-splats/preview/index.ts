// render-gaussian-splats: one static set of splats made in code (no capture, no file), drawn by the
// plugin's EWA renderer the way its README shows: uploaded once, then rendered every frame through
// the camera's matrices (camera-keyframes' matricesOf). The set is a plain test pattern: a sphere of
// flat grey splats with white meridians and parallels of long thin splats, so the orbit reads. The
// camera goes once round it a loop, rising and falling; the splats never change, only the view and
// the back-to-front order the plugin sorts every frame.

import { createHouse, type Word } from '../../previews/src/house.ts'
import { lens, matricesOf, type Shot } from '../../previews/src/motion/camera.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import { createSplatRenderer, type Splats } from '../../previews/src/render/splats.ts'

const TAU = Math.PI * 2
const RADIUS = 1.2
/** Flat grey splats covering the sphere. */
const SKIN = 9_000
/** White lines: meridians every 30°, parallels every 30° of latitude. */
const MERIDIANS = 12
const PARALLELS = [-60, -30, 0, 30, 60]
/** Splats along each line, a full circle. */
const PER_LINE = 360

type V3 = [number, number, number]
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/** The quaternion (w, x, y, z) of the rotation whose columns are a splat's own x, y and z axes. */
const quat = (ax: V3, ay: V3, az: V3): [number, number, number, number] => {
  const [m00, m10, m20] = ax
  const [m01, m11, m21] = ay
  const [m02, m12, m22] = az
  const tr = m00 + m11 + m22
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    return [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s]
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s]
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s]
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s]
}

/** The test pattern as plain typed arrays, the way the README says to build splats in code. */
const sphere = (): Splats => {
  const lines = (MERIDIANS + PARALLELS.length) * PER_LINE
  const count = SKIN + lines
  const s: Splats = {
    count,
    positions: new Float32Array(count * 3),
    scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    colors: new Float32Array(count * 4),
  }
  let i = 0
  /** A splat at unit direction `d` on the sphere, lying along `along`. */
  const add = (d: V3, along: V3, scale: V3, grey: number, alpha: number, lift = 1) => {
    const side = norm(cross(d, along))
    const a = cross(side, d)
    s.positions.set([d[0] * RADIUS * lift, d[1] * RADIUS * lift, d[2] * RADIUS * lift], i * 3)
    s.scales.set(scale, i * 3)
    s.rotations.set(quat(a, side, d), i * 4)
    s.colors.set([grey, grey, grey, alpha], i * 4)
    i++
  }
  // The skin: an even spread (a Fibonacci sphere) of flat discs lying on the surface.
  for (let k = 0; k < SKIN; k++) {
    const y = 1 - (2 * (k + 0.5)) / SKIN
    const r = Math.sqrt(1 - y * y)
    const th = k * 2.399963229728653
    const d: V3 = [r * Math.cos(th), y, r * Math.sin(th)]
    add(d, norm(cross([0, 1, 0], d)), [0.045, 0.045, 0.006], 0.3, 0.75)
  }
  // The lines: long thin splats end to end, a little proud of the skin.
  for (let m = 0; m < MERIDIANS; m++) {
    const lon = (m / MERIDIANS) * TAU
    for (let k = 0; k < PER_LINE; k++) {
      const lat = (k / PER_LINE) * TAU
      const d: V3 = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]
      const along: V3 = [
        -Math.sin(lat) * Math.cos(lon),
        Math.cos(lat),
        -Math.sin(lat) * Math.sin(lon),
      ]
      add(d, along, [0.014, 0.004, 0.002], 1, 0.95, 1.004)
    }
  }
  for (const deg of PARALLELS) {
    const lat = (deg * Math.PI) / 180
    for (let k = 0; k < PER_LINE; k++) {
      const lon = (k / PER_LINE) * TAU
      const d: V3 = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]
      add(d, [-Math.sin(lon), 0, Math.cos(lon)], [0.014, 0.004, 0.002], 1, 0.95, 1.004)
    }
  }
  return s
}

const renderGaussianSplats: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-gaussian-splats has no state "${stateId}"`)
  const device = host.gpu
  if (!device) throw new Error('The render-gaussian-splats preview needs WebGPU (host.gpu)')
  const { width: W, height: H, duration } = host.manifest
  const splats = createSplatRenderer(device, { width: W, height: H })
  const set = sphere()
  splats.upload(set)

  const bg = host.io.canvas(W, H)
  const bgCtx = bg.getContext('2d') as OffscreenCanvasRenderingContext2D
  bgCtx.fillStyle = '#000'
  bgCtx.fillRect(0, 0, W, H)
  createHouse(host, bgCtx).index()
  const canvas = host.io.canvas(W, H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const top: Word[] = [{ from: 0, to: duration, text: 'ORBIT' }]
  const bottom: Word[] = [
    {
      from: 0,
      to: duration,
      text: `${set.count.toLocaleString('en-US').replace(',', ' ')} SPLATS`,
    },
  ]

  /** The camera: once round the sphere a loop, rising and falling twice. */
  const camera = (t: number): Shot => {
    const ph = t / duration
    const az = ph * TAU + 0.6
    const h = 1.4 * Math.sin(ph * TAU * 2)
    const dist = 6.4
    return {
      eye: [dist * Math.sin(az), h, dist * Math.cos(az)],
      target: [0, 0, 0],
      fov: lens(50, 1),
      roll: 0,
      // The subject sits in the middle of the picture above the caption.
      shift: [0, 0.082],
    }
  }
  const azimuth = (t: number) => ((((t / duration) * 360 + 34.4) % 360) + 360) % 360

  return {
    async render(t, o) {
      const { view, projection } = o.camera ?? matricesOf(camera(t), W / H)
      const frame = splats.render(view, projection)
      ctx.clearRect(0, 0, W, H)
      theme.wash(W)
      theme.words(top, bottom, t, o.frame)
      theme.note('one set of splats, sorted back to front every frame', 1032, 800)
      theme.hud(
        t,
        o.frame,
        `SORTED ${splats.order.length.toLocaleString('en-US')} BACK TO FRONT   EWA`,
        `AZIMUTH ${azimuth(t).toFixed(0).padStart(3, '0')}°`,
      )
      return [
        { color: bg, name: 'black' },
        { color: frame, alpha: 'premultiplied', name: 'splats' },
        { color: canvas, name: 'header' },
      ]
    },
    status(t) {
      return `orbit  ${azimuth(t).toFixed(0)}°`
    },
    inspect(t) {
      const c = camera(t)
      return { id: 'splats', count: set.count, eye: [...c.eye], azimuth: azimuth(t) }
    },
  }
}

export default renderGaussianSplats
