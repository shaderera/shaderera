// render-gaussian-splats: 60 000 Gaussian splats made in code (no capture, no file), drawn by the
// item's EWA renderer. Every splat has a place in three forms and morphs between them in a wave
// that sweeps through the cloud: a ball of brushed fur, a torus knot whose skin slides along
// itself, a rippling sheet. Each splat is a long thin ellipse lying along the form, so close up
// they read as brush strokes, from afar as a surface; the camera circles and dives in to show
// both. The cloud is rebuilt and re-sorted back to front every frame.

import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import { lens, projectionMatrix, type Shot, viewMatrix } from '../../previews/src/motion/camera.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import { createSplatRenderer, type Splats } from '../../previews/src/render/splats.ts'

const COUNT = 60_000
const TAU = Math.PI * 2
const FORMS = ['fur', 'knot', 'sheet'] as const
/** When each morph starts (to the next form); a splat's own start is delayed by its place. */
const MORPHS = [1.4, 3.4, 5.0]
const MORPH = 0.55
const SPREAD = 0.45

type V3 = [number, number, number]
const hash = (i: number, k: number) => {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x27d4eb2f)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

/** A splat in one form: where it is, the direction it lies along, its normal, size, colour. */
type Place = { p: V3; along: V3; normal: V3; scale: V3; color: [number, number, number, number] }

/** The knot's centre line and its frame at s. */
const knot = (s: number) => {
  const at = (u: number): V3 => {
    const r = 2 + Math.cos(3 * u)
    return [0.5 * r * Math.cos(2 * u), 0.5 * Math.sin(3 * u) * 1.1, 0.5 * r * Math.sin(2 * u)]
  }
  const c = at(s)
  const d = 1e-3
  const a = at(s + d)
  const b = at(s - d)
  const tangent = norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
  const side = norm(cross(tangent, norm(c)))
  const up = cross(side, tangent)
  return { c, tangent, side, up }
}

const place = (form: number, i: number, ph: number): Place => {
  const r1 = hash(i, 1)
  const r2 = hash(i, 2)
  const r3 = hash(i, 3)
  if (form === 0) {
    // Fur: every splat on a sphere, lying along a flow that wanders with a noise field, the tips
    // rising and falling in a wave that crosses the ball twice a loop.
    const y = 1 - 2 * ((i + 0.5) / COUNT)
    const rr = Math.sqrt(1 - y * y)
    const th = i * 2.399963229728653 + ph * TAU
    const d: V3 = [rr * Math.cos(th), y, rr * Math.sin(th)]
    const swirl: V3 = norm([
      Math.sin(d[1] * 3.1 + 1.3) + 0.6,
      Math.sin(d[2] * 2.7 + 4.1),
      Math.sin(d[0] * 3.3 + 2.2),
    ])
    const along = norm(cross(d, swirl))
    const wave = Math.sin(d[0] * 2.5 + d[1] * 4 - ph * TAU * 2)
    const lift = 1.05 + 0.32 * r1 ** 2 + 0.16 * wave
    const tip = r1 ** 2
    const g = 0.35 + 0.65 * tip
    const red = wave > 0.9 && r3 > 0.4
    return {
      p: [d[0] * lift, d[1] * lift + 0.05, d[2] * lift],
      along,
      normal: d,
      scale: [0.09 + 0.06 * r2, 0.012, 0.012],
      color: red ? [1, 0.78, 0.66, 0.95] : [g, g, g * 1.02, 0.55 + 0.4 * r3],
    }
  }
  if (form === 1) {
    // The knot: a tube whose skin slides along the knot once a loop.
    const s = r1 * TAU + ph * TAU
    const f = knot(s)
    const a = r2 * TAU
    const tube = 0.3 + 0.03 * (r3 - 0.5)
    const n: V3 = [
      Math.cos(a) * f.side[0] + Math.sin(a) * f.up[0],
      Math.cos(a) * f.side[1] + Math.sin(a) * f.up[1],
      Math.cos(a) * f.side[2] + Math.sin(a) * f.up[2],
    ]
    const band = Math.sin(s * 6 - ph * TAU * 3)
    const lit = 0.25 + 0.75 * Math.max(0, n[1] * 0.6 + n[0] * 0.3 + 0.4)
    const red = band > 0.9
    return {
      p: [f.c[0] + n[0] * tube, f.c[1] + n[1] * tube + 0.05, f.c[2] + n[2] * tube],
      along: f.tangent,
      normal: n,
      scale: [0.11 + 0.05 * r3, 0.022, 0.006],
      color: red ? [0.8, 0.7, 1, 0.95] : [lit, lit, lit, 0.7 + 0.25 * r3],
    }
  }
  // The sheet: a disc of flat splats, rippled by two waves, crests lit.
  const rad = 2.3 * Math.sqrt(r1)
  const a = r2 * TAU
  const x = rad * Math.cos(a)
  const z = rad * Math.sin(a)
  const k1 = x * 1.6 + z * 0.7 - ph * TAU * 2
  const k2 = Math.hypot(x + 1.2, z - 0.8) * 2.4 - ph * TAU * 3
  const h = 0.22 * Math.sin(k1) + 0.12 * Math.sin(k2)
  const dx =
    0.22 * 1.6 * Math.cos(k1) +
    (0.12 * 2.4 * Math.cos(k2) * (x + 1.2)) / (Math.hypot(x + 1.2, z - 0.8) || 1)
  const dz =
    0.22 * 0.7 * Math.cos(k1) +
    (0.12 * 2.4 * Math.cos(k2) * (z - 0.8)) / (Math.hypot(x + 1.2, z - 0.8) || 1)
  const normal = norm([-dx, 1, -dz])
  const along = norm(cross(normal, [0, 0, 1]))
  const crest = smooth((h + 0.05) / 0.3)
  const g = 0.12 + 0.88 * crest * (1 - rad / 3)
  const red = h > 0.27 && r3 > 0.4
  return {
    p: [x, h + 0.1, z],
    along,
    normal,
    scale: [0.07 + 0.04 * r3, 0.016, 0.005],
    color: red ? [1, 0.8, 0.7, 0.9] : [g, g, g, 0.6 + 0.35 * r3],
  }
}

const renderGaussianSplats: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-gaussian-splats has no state "${stateId}"`)
  const device = host.gpu
  if (!device) throw new Error('The render-gaussian-splats preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const aspect = width / height
  const renderer = createSplatRenderer(device, { width, height })
  const bg = host.io.canvas(width, height)
  const bgCtx = bg.getContext('2d') as OffscreenCanvasRenderingContext2D
  bgCtx.fillStyle = '#000'
  bgCtx.fillRect(0, 0, width, height)
  createHouse(host, bgCtx).index()
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const NOTES = [
    'each splat a long thin ellipse, lying along the fur',
    'the skin slides along the knot, sorted every frame',
    'flat splats on a rippling sheet, crests lit',
  ]
  // The form is the big word; it scrambles in as the morph sweeps through.
  const forms: Word[] = [
    { from: 0, to: MORPHS[0] ?? 0, text: 'FUR' },
    { from: MORPHS[0] ?? 0, to: MORPHS[1] ?? 0, text: 'KNOT' },
    { from: MORPHS[1] ?? 0, to: MORPHS[2] ?? 0, text: 'SHEET' },
    { from: MORPHS[2] ?? 0, to: duration, text: 'FUR' },
  ]
  const count: Word[] = [{ from: 0, to: duration, text: '60 000 SPLATS' }]
  const splats: Splats = {
    count: COUNT,
    positions: new Float32Array(COUNT * 3),
    scales: new Float32Array(COUNT * 3),
    rotations: new Float32Array(COUNT * 4),
    colors: new Float32Array(COUNT * 4),
  }
  // Each splat's delay in the sweep: by its height in the sheet's frame, plus a little noise.
  const delay = Float32Array.from({ length: COUNT }, (_, i) => SPREAD * hash(i, 9))

  /** Which form the cloud is leaving at t, and each splat's share of the way to the next. */
  const formAt = (t: number) => {
    let k = MORPHS.findIndex((m) => t < m)
    if (k < 0) k = 0
    // Before the first morph the cloud is still finishing the last one (from the sheet to fur).
    const from = (k + FORMS.length - 1) % FORMS.length
    const start = MORPHS[(k + MORPHS.length - 1) % MORPHS.length] ?? 0
    const since = t - start + (t < start ? duration : 0)
    return { from, to: (from + 1) % FORMS.length, since }
  }

  const build = (t: number) => {
    const ph = t / duration
    const f = formAt(t)
    for (let i = 0; i < COUNT; i++) {
      const u = smooth((f.since - (delay[i] ?? 0)) / MORPH)
      const a = place(f.from, i, ph)
      const b = u > 0 ? place(f.to, i, ph) : a
      const mix = (x: number, y: number) => x + (y - x) * u
      // The path between forms bows outward, so the morph swirls rather than cuts through.
      const bow = Math.sin(u * Math.PI) * 0.5
      const p: V3 = [
        mix(a.p[0], b.p[0]) * (1 + bow * 0.4),
        mix(a.p[1], b.p[1]) + bow * (hash(i, 5) - 0.5),
        mix(a.p[2], b.p[2]) * (1 + bow * 0.4),
      ]
      const along = norm([
        mix(a.along[0], b.along[0]),
        mix(a.along[1], b.along[1]),
        mix(a.along[2], b.along[2]),
      ])
      let normal = norm([
        mix(a.normal[0], b.normal[0]),
        mix(a.normal[1], b.normal[1]),
        mix(a.normal[2], b.normal[2]),
      ])
      const side = norm(cross(normal, along))
      normal = cross(along, side)
      // R's columns are the splat's own axes: along, side, normal.
      const m00 = along[0],
        m10 = along[1],
        m20 = along[2]
      const m01 = side[0],
        m11 = side[1],
        m21 = side[2]
      const m02 = normal[0],
        m12 = normal[1],
        m22 = normal[2]
      const tr = m00 + m11 + m22
      let w: number, x: number, y: number, z: number
      if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2
        w = 0.25 * s
        x = (m21 - m12) / s
        y = (m02 - m20) / s
        z = (m10 - m01) / s
      } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2
        w = (m21 - m12) / s
        x = 0.25 * s
        y = (m01 + m10) / s
        z = (m02 + m20) / s
      } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2
        w = (m02 - m20) / s
        x = (m01 + m10) / s
        y = 0.25 * s
        z = (m12 + m21) / s
      } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2
        w = (m10 - m01) / s
        x = (m02 + m20) / s
        y = (m12 + m21) / s
        z = 0.25 * s
      }
      splats.positions.set(p, i * 3)
      // Mid-morph the strokes stretch, like paint dragged.
      const stretch = 1 + 1.6 * Math.sin(u * Math.PI)
      splats.scales.set(
        [
          mix(a.scale[0], b.scale[0]) * stretch,
          mix(a.scale[1], b.scale[1]),
          mix(a.scale[2], b.scale[2]),
        ],
        i * 3,
      )
      splats.rotations.set([w, x, y, z], i * 4)
      splats.colors.set(
        [
          mix(a.color[0], b.color[0]),
          mix(a.color[1], b.color[1]),
          mix(a.color[2], b.color[2]),
          mix(a.color[3], b.color[3]),
        ],
        i * 4,
      )
    }
    renderer.upload(splats)
    return f
  }

  /** The camera: once round the cloud a loop, diving close twice to show the strokes. */
  const camera = (t: number): Shot => {
    const ph = t / duration
    const az = ph * TAU + 0.6
    const dist = 7 - 2.6 * Math.max(0, Math.sin(ph * TAU * 2 - 0.9)) ** 2
    const h = 1.2 + 0.9 * Math.sin(ph * TAU + 1)
    return {
      eye: [dist * Math.sin(az), h, dist * Math.cos(az)],
      target: [0, 0.15, 0],
      fov: lens(40, 1),
      roll: 0.08 * Math.sin(ph * TAU * 2),
      shift: [0, 0.082],
    }
  }

  return {
    async render(t, o) {
      const f = build(t)
      const c = camera(t)
      const frame = renderer.render(viewMatrix(c), projectionMatrix(c, aspect))
      ctx.clearRect(0, 0, width, height)
      theme.wash(width)
      theme.words(forms, count, t, o.frame)
      const morphing = f.since < MORPH + SPREAD
      theme.note(
        morphing ? 'every splat morphing in a sweep, 60 000 at once' : (NOTES[f.to] ?? ''),
        1032,
        800,
      )
      theme.hud(
        t,
        o.frame,
        `SORTED ${renderer.order.length.toLocaleString('en-US')} BACK TO FRONT   EWA`,
        morphing ? `${FORMS[f.from]?.toUpperCase()} > ${FORMS[f.to]?.toUpperCase()}` : '',
      )
      // The morph's sweep as a red marker under the top word.
      if (morphing) {
        ctx.fillStyle = RED
        ctx.fillRect(48, 140, 300 * Math.min(1, f.since / (MORPH + SPREAD)), 2)
      }
      return [
        { color: bg, name: 'black' },
        { color: frame, alpha: 'premultiplied', name: 'splats' },
        { color: canvas, name: 'header' },
      ]
    },
    status(t) {
      const f = formAt(t)
      return f.since < MORPH + SPREAD ? `morph  ${FORMS[f.to]}` : (FORMS[f.to] ?? '')
    },
    inspect(t) {
      const f = formAt(t)
      return {
        id: 'splats',
        count: COUNT,
        from: FORMS[f.from] ?? '',
        to: FORMS[f.to] ?? '',
        since: f.since,
      }
    },
  }
}

export default renderGaussianSplats
