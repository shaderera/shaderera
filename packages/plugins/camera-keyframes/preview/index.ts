// camera-keyframes: a camera on keyframed shots films a plain grey box on a floor grid
// (stage.ts). 'track' is five shots, each move coming to rest on its key: a wide 35 mm, an orbit
// to 50 mm, a crane to a 24 mm top shot, a hard cut to an 85 mm close-up, a straight fly-by, and a
// spring back to the first. 'path' is one move that flows through six shots without stopping. The
// camera's own route is drawn into the scene as a thin white line with red key markers, and the
// keys sit on a timeline with each move's ease drawn as a curve. The move and the lens are the big
// words (house.ts).

import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import {
  cameraPath,
  cameraTrack,
  FILL,
  fit,
  type Key,
  lens,
  type Shot,
  shot,
  viewProjection,
} from '../../previews/src/motion/camera.ts'
import { type Ease, glide, hold, linear, settle, smooth } from '../../previews/src/motion/eases.ts'
import type { V3 } from '../../previews/src/motion/keyframes.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { createStage, project, SUBJECT } from './stage.ts'

const L = 48
const R = 1032
/** The caption covers the bottom; shots lift the subject to the middle of the picture above it. */
const LIFT: readonly [number, number] = [0, 0.082]

type Move = { at: number; shot: Shot; mm: number; ease: Ease; easeName: string; move: string }

const framed = (mm: number, azimuth: number, elevation: number, fill: number): Shot =>
  fit({
    center: SUBJECT.center,
    radius: SUBJECT.radius,
    azimuth,
    elevation,
    fov: lens(mm, 1),
    aspect: 1,
    fill,
    shift: LIFT,
  })

const TRACK: Move[] = [
  { at: 0, shot: framed(35, 35, 20, FILL.wide), mm: 35, ease: linear, easeName: '', move: 'wide' },
  {
    at: 1.4,
    shot: framed(50, 140, 7, FILL.medium),
    mm: 50,
    ease: glide,
    easeName: 'glide',
    move: 'orbit',
  },
  {
    at: 2.5,
    shot: framed(24, 160, 74, 0.28),
    mm: 24,
    ease: smooth,
    easeName: 'smooth',
    move: 'crane',
  },
  {
    // A hard cut, on the frame after the crane lands.
    at: 2.5 + 1 / 30,
    shot: fit({
      center: [0, 2.2, 0],
      radius: 1.1,
      azimuth: 250,
      elevation: 9,
      fov: lens(85, 1),
      aspect: 1,
      fill: FILL.close,
      shift: LIFT,
    }),
    mm: 85,
    ease: hold,
    easeName: '',
    move: 'cut',
  },
  {
    at: 4.4,
    shot: shot([-8, 3, -5], [0, 1.2, 0], lens(28, 1), 0, { path: 'line', shift: LIFT }),
    mm: 28,
    ease: smooth,
    easeName: 'smooth',
    move: 'fly-by',
  },
]
TRACK.push({ ...(TRACK[0] as Move), at: 6, ease: settle(9), easeName: 'settle', move: 'land' })

/**
 * One flowing move round the box: start high, sweep low round it, drop to the floor and look up
 * at it, climb away. Every shot looks at the box, so the target holds still while the eye flows.
 */
const AIM: V3 = SUBJECT.center
const PATH: { shot: Shot; mm: number }[] = [
  { shot: shot([7, 6.4, 10], AIM, lens(35, 1), 0, { shift: LIFT }), mm: 35 },
  { shot: shot([10, 3.6, 0], AIM, lens(24, 1), 0.12, { shift: LIFT }), mm: 24 },
  { shot: shot([4.2, 2, -3.4], AIM, lens(28, 1), 0, { shift: LIFT }), mm: 28 },
  { shot: shot([-3.6, 0.5, -3.2], AIM, lens(20, 1), -0.15, { shift: LIFT }), mm: 20 },
  { shot: shot([-9, 9, 7], AIM, lens(35, 1), 0, { shift: LIFT }), mm: 35 },
]
PATH.push(PATH[0] as { shot: Shot; mm: number })

const mmOf = (fov: number) => 35 / (2 * Math.tan((fov * Math.PI) / 360))

const NOTES: Record<string, string> = {
  wide: 'a 35 mm wide, the subject fitted exactly',
  orbit: 'glides round the target, keeping its distance',
  crane: 'cranes up to a top shot on a 24 mm',
  cut: 'a cut, held to the frame: an 85 mm close-up',
  'fly-by': 'a straight flight past the subject',
  land: 'lands on the first shot like a spring',
}

const cameraKeyframes: OpenPreview = async (host, stateId) => {
  if (stateId !== 'track' && stateId !== 'path')
    throw new Error(`camera-keyframes has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const fps = Number(host.manifest.fps)
  const aspect = width / height
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const stage = createStage(ctx, width, height)
  const options = { designed: 1 }

  const camera =
    stateId === 'track'
      ? cameraTrack(
          TRACK.map((k) => [k.at, k.shot, k.ease] as Key<Shot>),
          options,
        )
      : cameraPath(
          PATH.map((p) => p.shot),
          0,
          duration,
          smooth,
          options,
        )
  // The keys as the timeline and the route show them.
  const keys =
    stateId === 'track'
      ? TRACK.map((k) => ({ at: k.at, eye: k.shot.eye, mm: k.mm, ease: k.ease, name: k.easeName }))
      : PATH.map((p, i) => ({
          at: (i * duration) / (PATH.length - 1),
          eye: camera((i * duration) / (PATH.length - 1), aspect).eye,
          mm: p.mm,
          ease: linear,
          name: i === 1 ? 'smooth, one ease over the whole move' : '',
        }))
  // The big words: the move (top left) and the lens it lands on (bottom right).
  const moves: Word[] =
    stateId === 'track'
      ? TRACK.slice(1).map((k, i) => ({
          from: (TRACK[i] as Move).at,
          to: k.at,
          text: k.move.toUpperCase(),
        }))
      : [
          { from: 0, to: 2, text: 'SWEEP' },
          { from: 2, to: 4, text: 'DIVE' },
          { from: 4, to: 6, text: 'CLIMB' },
        ]
  const lenses: Word[] =
    stateId === 'track'
      ? TRACK.slice(1).map((k, i) => ({
          from: (TRACK[i] as Move).at,
          to: k.at,
          text: `${k.mm} MM`,
        }))
      : PATH.slice(1).map((p, i) => ({
          from: (i * duration) / (PATH.length - 1),
          to: ((i + 1) * duration) / (PATH.length - 1),
          text: `${p.mm} MM`,
        }))
  // The route: the eye every frame over the loop, broken at a cut.
  const route = Array.from({ length: 241 }, (_, i) => {
    const t = (i / 240) * duration
    return { t, eye: camera(t, aspect).eye }
  })

  const state = (t: number) => {
    const c = camera(t, aspect)
    let k = keys.findIndex((key, i) => i > 0 && t < key.at)
    if (k < 0) k = keys.length - 1
    const from = keys[k - 1] ?? keys[0]
    const to = keys[k] ?? keys[0]
    const u = from && to ? Math.min(1, Math.max(0, (t - from.at) / (to.at - from.at))) : 0
    const move = stateId === 'track' ? (TRACK[k]?.move ?? '') : 'flow'
    return { c, k, u, move, mm: mmOf(c.fov) }
  }

  const drawRoute = (vp: Float32Array, t: number) => {
    ctx.save()
    ctx.lineCap = 'round'
    // A thin white line, bright ahead of the camera and faint behind it; the cut leaves a gap.
    let last: { x: number; y: number } | null = null
    let lastEye = route[0]?.eye
    for (const p of route) {
      const s = project(vp, p.eye, width, height)
      const jump =
        lastEye &&
        Math.hypot(p.eye[0] - lastEye[0], p.eye[1] - lastEye[1], p.eye[2] - lastEye[2]) > 1.5
      lastEye = p.eye
      if (s && last && !jump && s.w > 0.6) {
        ctx.strokeStyle = p.t > t ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.3)'
        ctx.lineWidth = Math.min(3, Math.max(1.2, 20 / s.w))
        ctx.beginPath()
        ctx.moveTo(last.x, last.y)
        ctx.lineTo(s.x, s.y)
        ctx.stroke()
      }
      last = s && s.w > 0.6 ? s : null
    }
    // A dot every tenth of a second: bunched where a move eases, spread where it is fast.
    route.forEach((p, i) => {
      if (i % 4 !== 0 || p.t <= t) return
      const s = project(vp, p.eye, width, height)
      if (!s || s.w < 0.6) return
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(s.x, s.y, Math.min(3.5, Math.max(1.5, 22 / s.w)), 0, Math.PI * 2)
      ctx.fill()
    })
    // Every key where its camera stands: a red marker, its number and lens.
    ctx.font = `14px "${FONT.mono}"`
    ctx.textAlign = 'left'
    keys.forEach((key, i) => {
      if (i === keys.length - 1) return
      const s = project(vp, key.eye, width, height)
      if (!s || s.w < 0.8 || s.y > 800 || s.y < 150) return
      const size = Math.min(14, Math.max(7, 80 / s.w))
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      ctx.strokeRect(s.x - size / 2, s.y - size / 2, size, size)
      ctx.fillStyle = RED
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4)
      ctx.fillText(`K${i + 1}  ${key.mm} MM`, s.x + size / 2 + 6, s.y + 5)
    })
    ctx.restore()
  }

  // The keys on a timeline, each move's ease drawn as its curve between them.
  const drawTimeline = (t: number, s: ReturnType<typeof state>) => {
    const top = 712
    const h = 46
    const xOf = (time: number) => L + (time / duration) * (R - L)
    ctx.fillStyle = '#3a3a3a'
    ctx.fillRect(L, top + h, R - L, 1)
    ctx.font = `13px "${FONT.mono}"`
    ctx.textAlign = 'left'
    const easeOf = (b: (typeof keys)[number], a: (typeof keys)[number], u: number) =>
      stateId === 'path'
        ? smooth(a.at / duration + (u * (b.at - a.at)) / duration)
        : b.ease === hold
          ? u < 1
            ? 0
            : 1
          : b.ease(u)
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1]
      const b = keys[i]
      if (!a || !b) continue
      const x0 = xOf(a.at)
      const x1 = xOf(b.at)
      const current = i === s.k
      ctx.strokeStyle = current ? '#fff' : 'rgba(255,255,255,0.35)'
      ctx.lineWidth = current ? 2 : 1.2
      ctx.beginPath()
      for (let j = 0; j <= 48; j++) {
        const u = j / 48
        const y = top + h - easeOf(b, a, u) * h
        if (j === 0) ctx.moveTo(x0 + u * (x1 - x0), y)
        else ctx.lineTo(x0 + u * (x1 - x0), y)
      }
      ctx.stroke()
      ctx.fillStyle = current ? '#fff' : '#7a7a7a'
      if (b.name) ctx.fillText(b.name.toUpperCase(), x0 + 6, top - 8)
    }
    // Keys as red diamonds.
    keys.forEach((key, i) => {
      const x = xOf(key.at)
      ctx.fillStyle = key.at <= t + 1e-6 ? RED : '#000'
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, top + h - 7)
      ctx.lineTo(x + 7, top + h)
      ctx.lineTo(x, top + h + 7)
      ctx.lineTo(x - 7, top + h)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      const crowded = i > 0 && key.at - (keys[i - 1]?.at ?? 0) < 0.2
      if (i < keys.length - 1 && !crowded) {
        ctx.fillStyle = '#8a8a8a'
        ctx.fillText(`K${i + 1}`, x + 10, top + h + 22)
      }
    })
    // The playhead, and a dot on the curve where the move is now.
    const x = xOf(t)
    ctx.fillStyle = '#fff'
    ctx.fillRect(x - 0.5, top - 4, 1.5, h + 14)
    const a = keys[s.k - 1]
    const b = keys[s.k]
    const v = a && b ? easeOf(b, a, s.u) : 0
    ctx.beginPath()
    ctx.arc(x, top + h - v * h, 5, 0, Math.PI * 2)
    ctx.fill()
  }

  const drawTarget = (vp: Float32Array, c: Shot) => {
    const p = project(vp, c.target, width, height)
    if (!p) return
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      ctx.moveTo(p.x + dx * 6, p.y + dy * 6)
      ctx.lineTo(p.x + dx * 18, p.y + dy * 18)
    }
    ctx.stroke()
  }

  return {
    async render(t, o) {
      const s = state(t)
      const vp = viewProjection(s.c, aspect)
      stage.draw(vp, s.c.eye)
      theme.wash(width)
      theme.index()
      drawRoute(vp, t)
      drawTarget(vp, s.c)
      drawTimeline(t, s)
      theme.words(moves, lenses, t, o.frame)
      theme.note(
        stateId === 'track' ? (NOTES[s.move] ?? '') : 'one move through every shot, never stopping',
        R,
        800,
      )
      const e = s.c.eye
      theme.hud(
        t,
        o.frame,
        `EYE ${e.map((v) => v.toFixed(2)).join(' ')}   FOV ${s.c.fov.toFixed(2)}`,
        `${s.mm.toFixed(1)} MM   ${fps} FPS`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return stateId === 'track'
        ? `${String(Math.max(1, s.k)).padStart(2, '0')}/${String(keys.length - 1).padStart(2, '0')}  ${s.move}`
        : `path  ${s.mm.toFixed(0)} mm`
    },
    inspect(t) {
      const s = state(t)
      return {
        id: 'camera',
        state: stateId,
        key: s.k,
        move: s.move,
        eye: [...s.c.eye],
        target: [...s.c.target],
        fov: s.c.fov,
        mm: s.mm,
      }
    },
  }
}

export default cameraKeyframes
