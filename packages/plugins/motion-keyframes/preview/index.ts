// motion-keyframes: one shape keyed through seven poses, every move with a different ease, as a
// motion designer sees it. On the stage the shape travels, turns, grows and morphs (square,
// circle, triangle, star) from key to key, trailing onion skins one frame apart, so the spacing
// shows the ease: bunched where it is slow, spread where it is fast, past the key where it
// overshoots, nothing where it holds and cuts. A swarm of points follows it, each reading the same
// tracks a little later (the plugin's way to follow a subject), so the frame never rests. Below,
// the graph editor: x and y over the loop, the keys as red diamonds. The ease is the big word, its
// formula the note (house.ts).

import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import {
  back,
  bezier,
  type Ease,
  expo,
  glide,
  hold,
  type Key,
  settle,
  strike,
  track,
} from '../../previews/src/motion/keyframes.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = 48
const R = 1032
const STAGE = { left: 110, right: 970, top: 160, bottom: 560 }
const GRAPH = { top: 620, bottom: 740 }
const SHAPES = ['square', 'circle', 'triangle', 'star']

type Pose = { at: number; x: number; y: number; size: number; turn: number; shape: number }
/** The keys, and the ease each move into a key uses (the first key has none). */
const KEYS: (Pose & { ease?: Ease; name?: string; note?: string })[] = [
  { at: 0, x: 230, y: 420, size: 150, turn: 0, shape: 0 },
  {
    at: 0.8,
    x: 760,
    y: 250,
    size: 105,
    turn: 90,
    shape: 1,
    ease: strike,
    name: 'strike',
    note: 'a hit: out fast, then a long settle',
  },
  {
    at: 1.7,
    x: 860,
    y: 460,
    size: 190,
    turn: 150,
    shape: 2,
    ease: back(2.4),
    name: 'back',
    note: 'overshoots the key, then comes back to it',
  },
  {
    at: 2.6,
    x: 480,
    y: 340,
    size: 250,
    turn: 216,
    shape: 3,
    ease: settle(10),
    name: 'settle',
    note: 'a damped spring, as a formula of t',
  },
  {
    at: 3.4,
    x: 210,
    y: 240,
    size: 115,
    turn: 288,
    shape: 1,
    ease: expo,
    name: 'expo',
    note: 'still, then fast, then still',
  },
  {
    at: 4.3,
    x: 590,
    y: 470,
    size: 170,
    turn: 315,
    shape: 0,
    ease: bezier(0.8, 0, 0.2, 1),
    name: 'bezier',
    note: 'bezier(0.8, 0, 0.2, 1), as drawn in a curve editor',
  },
  {
    at: 4.6,
    x: 880,
    y: 270,
    size: 140,
    turn: 330,
    shape: 2,
    ease: hold,
    name: 'hold',
    note: 'holds, then cuts to the key',
  },
  {
    at: 6,
    x: 230,
    y: 420,
    size: 150,
    turn: 360,
    shape: 0,
    ease: glide,
    name: 'glide',
    note: 'a long, even glide in and out',
  },
]

const POINTS = 180
/** A shape's radius at an angle: square, circle, triangle, five-point star. */
const radius = (shape: number, a: number) => {
  const tau = Math.PI * 2
  switch (shape) {
    case 0:
      return 0.86 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)))
    case 2: {
      const k = tau / 3
      const m = ((((a + Math.PI / 2) % k) + k) % k) - k / 2
      return (0.62 / Math.cos(m)) * 1.05
    }
    case 3: {
      const k = tau / 5
      const m = Math.abs(((((a + Math.PI / 2) % k) + k) % k) - k / 2) / (k / 2)
      return 0.48 + 0.62 * (1 - m) ** 1.6
    }
    default:
      return 1
  }
}
const OUTLINES = [0, 1, 2, 3].map((s) =>
  Array.from({ length: POINTS }, (_, i) => radius(s, (i / POINTS) * Math.PI * 2)),
)
const rnd = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453
  return x - Math.floor(x)
}
const SWARM = Array.from({ length: 900 }, (_, i) => ({
  lag: 0.03 + 0.55 * rnd(i, 1) ** 1.4,
  at: Math.floor(rnd(i, 2) * POINTS),
  out: 1 + 0.5 * (rnd(i, 3) - 0.3),
  size: 1 + 1.8 * rnd(i, 4),
}))

const motionKeyframes: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`motion-keyframes has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const fps = Number(host.manifest.fps)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // Every property is a track of the plugin; `progress` counts keys, so its fraction is the eased
  // share of the current move (past 1 where an ease overshoots).
  const keyed = (pick: (p: Pose) => number) =>
    track(KEYS.map((k): Key<number> => (k.ease ? [k.at, pick(k), k.ease] : [k.at, pick(k)])))
  const x = keyed((p) => p.x)
  const y = keyed((p) => p.y)
  const size = keyed((p) => p.size)
  const turn = keyed((p) => p.turn)
  const progress = track(KEYS.map((k, i): Key<number> => (k.ease ? [k.at, i, k.ease] : [k.at, i])))
  const loop = (t: number) => ((t % duration) + duration) % duration

  const pose = (time: number) => {
    const t = loop(time)
    let seg = KEYS.findIndex((k, i) => i > 0 && t < k.at)
    if (seg < 0) seg = KEYS.length - 1
    const u = progress(t) - (seg - 1)
    return { t, seg, u, x: x(t), y: y(t), size: size(t), turn: turn(t) }
  }
  type P = ReturnType<typeof pose>

  const radii = (p: Pick<P, 'seg' | 'u'>) => {
    const a = OUTLINES[KEYS[p.seg - 1]?.shape ?? 0] as number[]
    const b = OUTLINES[KEYS[p.seg]?.shape ?? 0] as number[]
    return a.map((ra, i) => ra + ((b[i] ?? 1) - ra) * p.u)
  }
  const outline = (p: P) => {
    const turnRad = (p.turn * Math.PI) / 180
    return radii(p).map((r, i) => {
      const ang = (i / POINTS) * Math.PI * 2 + turnRad
      return [
        p.x + Math.cos(ang) * r * p.size * 0.5,
        p.y + Math.sin(ang) * r * p.size * 0.5,
      ] as const
    })
  }
  const path = (pts: readonly (readonly [number, number])[]) => {
    ctx.beginPath()
    pts.forEach(([px, py], i) => {
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.closePath()
  }

  const drawStage = (t: number, p: P) => {
    // The key poses, faint, numbered.
    ctx.font = `14px ${mono}`
    ctx.textAlign = 'left'
    KEYS.slice(0, -1).forEach((k, i) => {
      const target: P = {
        t: k.at,
        seg: Math.max(1, i),
        u: i === 0 ? 0 : 1,
        x: k.x,
        y: k.y,
        size: k.size,
        turn: k.turn,
      }
      const next = i === p.seg % (KEYS.length - 1)
      ctx.strokeStyle = next ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)'
      ctx.setLineDash([4, 6])
      ctx.lineWidth = 1.2
      path(outline(target))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = next ? '#fff' : '#666'
      ctx.fillText(`K${i + 1}`, k.x + k.size * 0.5 + 10, k.y - k.size * 0.5)
    })
    // The swarm: each point reads the tracks a little behind, off the shape's outline.
    const cache = new Map<number, { p: P; r: number[] }>()
    for (const s of SWARM) {
      const time = Math.round((t - s.lag) * 240) / 240
      let c = cache.get(time)
      if (!c) {
        const q = pose(time)
        c = { p: q, r: radii(q) }
        cache.set(time, c)
      }
      const ang = (s.at / POINTS) * Math.PI * 2 + (c.p.turn * Math.PI) / 180
      const rr = (c.r[s.at] ?? 1) * c.p.size * 0.5 * s.out
      ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - s.lag / 0.62)})`
      ctx.fillRect(c.p.x + Math.cos(ang) * rr, c.p.y + Math.sin(ang) * rr, s.size, s.size)
    }
    // This move's spacing: a dot where the shape is on every frame of it.
    const from = KEYS[p.seg - 1]
    const to = KEYS[p.seg]
    if (from && to) {
      const n = Math.round((to.at - from.at) * fps)
      for (let j = 0; j <= n; j++) {
        const at = from.at + j / fps
        const q = pose(Math.min(at, to.at - 1e-4))
        ctx.fillStyle = at <= p.t ? 'rgba(255,255,255,0.35)' : '#fff'
        ctx.beginPath()
        ctx.arc(q.x, q.y, at <= p.t ? 2 : 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // A thin ring bursts from each key as the shape lands on it.
    for (const [i, k] of KEYS.entries()) {
      if (i === 0) continue
      const since = loop(t - k.at)
      if (since > 0.45) continue
      const e = 1 - (1 - since / 0.45) ** 3
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - since / 0.45)})`
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(k.x, k.y, k.size * 0.55 + e * 150, 0, Math.PI * 2)
      ctx.stroke()
    }
    // Onion skins, one frame apart, older ones fainter.
    for (let k = 8; k >= 1; k--) {
      ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - k / 9)})`
      ctx.lineWidth = 1.2
      path(outline(pose(t - k / fps)))
      ctx.stroke()
    }
    // The shape now, and its centre: the live point.
    ctx.fillStyle = '#fff'
    path(outline(p))
    ctx.fill()
    ctx.strokeStyle = RED
    ctx.lineWidth = 2
    ctx.strokeRect(p.x - 9, p.y - 9, 18, 18)
    ctx.fillStyle = RED
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4)
  }

  const drawGraph = (t: number, p: P) => {
    const { top, bottom } = GRAPH
    const xOf = (time: number) => L + (time / duration) * (R - L)
    const yOf = (v: number, lo: number, hi: number) =>
      bottom - ((v - lo) / (hi - lo)) * (bottom - top)
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    for (let i = 0; i <= 2; i++) ctx.fillRect(L, top + ((bottom - top) * i) / 2, R - L, 1)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    for (let i = 1; i < KEYS.length; i++) {
      const a = KEYS[i - 1] as Pose
      const b = KEYS[i] as Pose & { name?: string }
      const current = i === p.seg
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.fillRect(xOf(a.at), top - 22, 1, bottom - top + 22)
      ctx.fillStyle = current ? '#fff' : '#6a6a6a'
      if (xOf(b.at) - xOf(a.at) > 60)
        ctx.fillText((b.name ?? '').toUpperCase(), xOf(a.at) + 6, top - 8)
    }
    const curve = (
      fn: (time: number) => number,
      lo: number,
      hi: number,
      color: string,
      w: number,
    ) => {
      ctx.strokeStyle = color
      ctx.lineWidth = w
      ctx.beginPath()
      for (let i = 0; i <= 600; i++) {
        const time = (i / 600) * duration
        const yy = yOf(fn(time), lo, hi)
        if (i === 0) ctx.moveTo(xOf(time), yy)
        else ctx.lineTo(xOf(time), yy)
      }
      ctx.stroke()
      for (const k of KEYS) {
        const kx = xOf(k.at)
        const ky = yOf(fn(k.at), lo, hi)
        ctx.fillStyle = k.at <= t ? RED : '#000'
        ctx.strokeStyle = RED
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(kx, ky - 6)
        ctx.lineTo(kx + 6, ky)
        ctx.lineTo(kx, ky + 6)
        ctx.lineTo(kx - 6, ky)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }
    curve(y, STAGE.bottom, STAGE.top - 60, 'rgba(255,255,255,0.45)', 1.5)
    curve(x, STAGE.left, STAGE.right, '#fff', 2)
    // The playhead, and where each curve is now.
    const px = xOf(p.t)
    ctx.fillStyle = '#fff'
    ctx.fillRect(px - 0.5, top - 26, 1.5, bottom - top + 34)
    for (const [v, lo, hi] of [
      [p.x, STAGE.left, STAGE.right],
      [p.y, STAGE.bottom, STAGE.top - 60],
    ] as const) {
      ctx.beginPath()
      ctx.arc(px, yOf(v, lo, hi), 4.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText('X', L, bottom + 20)
    ctx.fillStyle = '#5a5a5a'
    ctx.fillText('Y', L + 20, bottom + 20)
  }

  const eases: Word[] = KEYS.slice(1).map((k, i) => ({
    from: (KEYS[i] as Pose).at,
    to: k.at,
    text: (k.name ?? '').toUpperCase(),
  }))
  const shapes: Word[] = KEYS.slice(1).map((k, i) => ({
    from: (KEYS[i] as Pose).at,
    to: k.at,
    text: (SHAPES[k.shape] ?? '').toUpperCase(),
  }))

  return {
    async render(t, o) {
      const p = pose(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      theme.index()
      drawStage(t, p)
      drawGraph(t, p)
      theme.words(eases, shapes, t, o.frame)
      theme.note(KEYS[p.seg]?.note ?? '', R, 800)
      theme.hud(
        t,
        o.frame,
        `X ${p.x.toFixed(0)}  Y ${p.y.toFixed(0)}  SIZE ${p.size.toFixed(0)}  TURN ${(p.turn % 360).toFixed(0)}°`,
        `KEY ${p.seg} > ${p.seg === KEYS.length - 1 ? 1 : p.seg + 1}   U ${p.u.toFixed(3)}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const p = pose(t)
      return `${String(p.seg).padStart(2, '0')}/${String(KEYS.length - 1).padStart(2, '0')}  ${KEYS[p.seg]?.name ?? ''}`
    },
    inspect(t) {
      const p = pose(t)
      return {
        id: 'shape',
        key: p.seg,
        ease: KEYS[p.seg]?.name ?? '',
        u: p.u,
        x: p.x,
        y: p.y,
        size: p.size,
        turn: p.turn,
      }
    },
  }
}

export default motionKeyframes
