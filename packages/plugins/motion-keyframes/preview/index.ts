// motion-keyframes: one plain square keyed through seven poses with `track`, every move with a
// different ease, as a motion designer sees it. On the stage the square travels, turns and grows
// from key to key, trailing onion skins one frame apart, with a dot where it is on every frame of
// the move, so the spacing shows the ease: bunched where it is slow, spread where it is fast, past
// the key where it overshoots, nothing where it holds and cuts. Below, the graph editor: x and y
// over the loop, the keys as red diamonds. The ease is the big word, its formula the note
// (house.ts).

import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import {
  back,
  bezier,
  type Ease,
  expo,
  glide,
  hold,
  type KeyObject,
  settle,
  strike,
  track,
} from '../../previews/src/motion/keyframes.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = 48
const R = 1032
const STAGE = { left: 110, right: 970, top: 160, bottom: 560 }
const GRAPH = { top: 620, bottom: 740 }

type Pose = { at: number; x: number; y: number; size: number; turn: number }
/** The keys, and the ease each move into a key uses (the first key has none). */
const KEYS: (Pose & { id: string; ease?: Ease; name?: string; note?: string })[] = [
  { id: 'k1', at: 0, x: 230, y: 420, size: 150, turn: 0 },
  {
    id: 'k2',
    at: 0.8,
    x: 760,
    y: 250,
    size: 105,
    turn: 90,
    ease: strike,
    name: 'strike',
    note: 'a hit: out fast, then a long settle',
  },
  {
    id: 'k3',
    at: 1.7,
    x: 860,
    y: 460,
    size: 190,
    turn: 150,
    ease: back(2.4),
    name: 'back',
    note: 'overshoots the key, then comes back to it',
  },
  {
    id: 'k4',
    at: 2.6,
    x: 480,
    y: 340,
    size: 250,
    turn: 216,
    ease: settle(10),
    name: 'settle',
    note: 'a damped spring, as a formula of t',
  },
  {
    id: 'k5',
    at: 3.4,
    x: 210,
    y: 240,
    size: 115,
    turn: 288,
    ease: expo,
    name: 'expo',
    note: 'still, then fast, then still',
  },
  {
    id: 'k6',
    at: 4.3,
    x: 590,
    y: 470,
    size: 170,
    turn: 315,
    ease: bezier(0.8, 0, 0.2, 1),
    name: 'bezier',
    note: 'bezier(0.8, 0, 0.2, 1), as drawn in a curve editor',
  },
  {
    id: 'k7',
    at: 4.6,
    x: 880,
    y: 270,
    size: 140,
    turn: 330,
    ease: hold,
    name: 'hold',
    note: 'holds, then cuts to the key',
  },
  {
    id: 'k8',
    at: 6,
    x: 230,
    y: 420,
    size: 150,
    turn: 360,
    ease: glide,
    name: 'glide',
    note: 'a long, even glide in and out',
  },
]

const motionKeyframes: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`motion-keyframes has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const fps = Number(host.manifest.fps)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // Every property is a track of the plugin, its keys objects with the pose's id; `progress`
  // counts keys, so its fraction is the eased share of the current move (past 1 where an ease
  // overshoots).
  const keyed = (pick: (p: Pose, i: number) => number) =>
    track(
      KEYS.map(
        (k, i): KeyObject<number> => ({ id: k.id, at: k.at, value: pick(k, i), ease: k.ease }),
      ),
    )
  const x = keyed((p) => p.x)
  const y = keyed((p) => p.y)
  const size = keyed((p) => p.size)
  const turn = keyed((p) => p.turn)
  const progress = keyed((_, i) => i)
  const loop = (t: number) => ((t % duration) + duration) % duration

  const pose = (time: number) => {
    const t = loop(time)
    let seg = KEYS.findIndex((k, i) => i > 0 && t < k.at)
    if (seg < 0) seg = KEYS.length - 1
    const u = progress(t) - (seg - 1)
    return { t, seg, u, x: x(t), y: y(t), size: size(t), turn: turn(t) }
  }
  type P = ReturnType<typeof pose>

  /** The square's corners, turned and sized by its tracks. */
  const outline = (p: Pick<P, 'x' | 'y' | 'size' | 'turn'>) =>
    [0, 1, 2, 3].map((i) => {
      const a = ((p.turn + 45 + i * 90) * Math.PI) / 180
      const r = (p.size / 2) * Math.SQRT2
      return [p.x + Math.cos(a) * r, p.y + Math.sin(a) * r] as const
    })
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
      const next = i === p.seg % (KEYS.length - 1)
      ctx.strokeStyle = next ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)'
      ctx.setLineDash([4, 6])
      ctx.lineWidth = 1.2
      path(outline(k))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = next ? '#fff' : '#666'
      ctx.fillText(`K${i + 1}`, k.x + k.size * 0.5 + 10, k.y - k.size * 0.5)
    })
    // This move's spacing: a dot where the square is on every frame of it.
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
    // Onion skins, one frame apart, older ones fainter.
    for (let k = 8; k >= 1; k--) {
      ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - k / 9)})`
      ctx.lineWidth = 1.2
      path(outline(pose(t - k / fps)))
      ctx.stroke()
    }
    // The square now, and its centre: the live point.
    ctx.fillStyle = '#4a4a4a'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    path(outline(p))
    ctx.fill()
    ctx.stroke()
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
  const targets: Word[] = KEYS.slice(1).map((k, i) => ({
    from: (KEYS[i] as Pose).at,
    to: k.at,
    text: `TO K${i + 2 === KEYS.length ? 1 : i + 2}`,
  }))

  return {
    async render(t, o) {
      const p = pose(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      theme.index()
      drawStage(t, p)
      drawGraph(t, p)
      theme.words(eases, targets, t, o.frame)
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
        id: 'square',
        key: p.seg,
        move: x.inspect(loop(t)),
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
