// motion-eases: six eases, a second each. Above, the ease's curve (u across, its value up) with a
// dot on it, and a plain square carried across a lane by `lerp` and `progress` with that ease,
// trailing a dot on every frame so the spacing shows the ease. Below, `envelope` over the loop's
// hits (red ticks): its curve, the playhead, and a bar that kicks on every hit. The ease is the big
// word, its use the note (house.ts).

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import {
  back,
  bezier,
  type Ease,
  envelope,
  expo,
  glide,
  lerp,
  progress,
  settle,
  strike,
} from '../../previews/src/motion/eases.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const EASES: { name: string; ease: Ease; note: string }[] = [
  { name: 'strike', ease: strike, note: 'out fast, then a long settle' },
  { name: 'back', ease: back(2.4), note: 'past the end, then back to it' },
  { name: 'settle', ease: settle(10), note: 'a damped spring, as a formula of u' },
  { name: 'expo', ease: expo, note: 'still, then fast, then still' },
  { name: 'bezier', ease: bezier(0.8, 0, 0.2, 1), note: 'bezier(0.8, 0, 0.2, 1)' },
  { name: 'glide', ease: glide, note: 'a long, even glide in and out' },
]
/** Each ease moves for this much of its second, then holds. */
const MOVE = 0.8
const HITS = [0.5, 1.5, 2, 2.25, 3.5, 4.5, 5, 5.25]
const GRAPH = { left: L, top: 170, size: 330 }
const LANE = { left: 470, right: 860, y: 340, size: 70 }
const ENV = { top: 600, bottom: 760 }

const preview: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`motion-eases has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const fps = Number(host.manifest.fps)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`
  const loop = (t: number) => ((t % duration) + duration) % duration
  // The hits of the loop before too, so the tail runs over the seam.
  const times = [...HITS.map((h) => h - duration), ...HITS]
  const env = (t: number) => envelope(loop(t), times, { attack: 0.03, decay: 0.25 })

  const at = (t: number) => {
    const x = loop(t)
    const i = Math.min(EASES.length - 1, Math.floor(x))
    const e = EASES[i] as (typeof EASES)[number]
    return { i, e, from: i, u: Math.min(1, (x - i) / MOVE), p: progress(x, i, i + MOVE, e.ease) }
  }

  const drawGraph = (s: ReturnType<typeof at>) => {
    const { left, top, size } = GRAPH
    const lo = -0.2
    const hi = 1.3
    const xOf = (u: number) => left + u * size
    const yOf = (v: number) => top + size - ((v - lo) / (hi - lo)) * size
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1
    ctx.strokeRect(left, yOf(1), size, yOf(0) - yOf(1))
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let k = 0; k <= 200; k++) {
      const u = k / 200
      if (k === 0) ctx.moveTo(xOf(u), yOf(s.e.ease(u)))
      else ctx.lineTo(xOf(u), yOf(s.e.ease(u)))
    }
    ctx.stroke()
    ctx.fillStyle = RED
    ctx.beginPath()
    ctx.arc(xOf(s.u), yOf(s.e.ease(s.u)), 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText('U', xOf(1) + 8, yOf(0) + 4)
    ctx.fillText(`${s.e.name.toUpperCase()}(U)`, left, yOf(1) - 10)
  }

  const drawLane = (t: number, s: ReturnType<typeof at>) => {
    const xOf = (p: number) => lerp(LANE.left, LANE.right, p)
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.fillRect(LANE.left, LANE.y, LANE.right - LANE.left, 1)
    for (const p of [0, 1]) ctx.fillRect(xOf(p), LANE.y - 50, 1, 100)
    // A dot where the square is on every frame of this move.
    const n = Math.round(MOVE * fps)
    for (let j = 0; j <= n; j++) {
      const time = s.from + j / fps
      const done = time <= loop(t)
      ctx.fillStyle = done ? 'rgba(255,255,255,0.35)' : '#fff'
      ctx.beginPath()
      ctx.arc(xOf(progress(time, s.from, s.from + MOVE, s.e.ease)), LANE.y + 70, done ? 2 : 3, 0, 7)
      ctx.fill()
    }
    const x = xOf(s.p)
    ctx.fillStyle = '#4a4a4a'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.fillRect(x - LANE.size / 2, LANE.y - LANE.size / 2, LANE.size, LANE.size)
    ctx.strokeRect(x - LANE.size / 2, LANE.y - LANE.size / 2, LANE.size, LANE.size)
  }

  const drawEnvelope = (t: number) => {
    const { top, bottom } = ENV
    const xOf = (time: number) => L + (time / duration) * (R - L)
    const yOf = (v: number) => bottom - v * (bottom - top)
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.fillRect(L, bottom, R - L, 1)
    ctx.fillRect(L, top, R - L, 1)
    for (const h of HITS) {
      ctx.fillStyle = RED
      ctx.fillRect(xOf(h) - 1, bottom + 6, 2, 14)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let k = 0; k <= 600; k++) {
      const time = (k / 600) * duration
      if (k === 0) ctx.moveTo(xOf(time), yOf(env(time)))
      else ctx.lineTo(xOf(time), yOf(env(time)))
    }
    ctx.stroke()
    const px = xOf(loop(t))
    ctx.fillStyle = '#fff'
    ctx.fillRect(px - 0.5, top - 10, 1.5, bottom - top + 20)
    ctx.beginPath()
    ctx.arc(px, yOf(env(t)), 5, 0, Math.PI * 2)
    ctx.fill()
    // The bar the envelope drives.
    const v = env(t)
    ctx.fillStyle = `rgba(255,255,255,${0.2 + 0.8 * v})`
    ctx.fillRect(L, top - 60, 40 + v * (R - L - 40), 22)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'right'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(`ENVELOPE ${v.toFixed(3)}`, R, top - 72)
  }

  const names: Word[] = EASES.map((e, i) => ({ from: i, to: i + 1, text: e.name.toUpperCase() }))
  const bottom: Word[] = [{ from: 0, to: duration, text: 'ENVELOPE' }]

  return {
    async render(t, o) {
      const s = at(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      drawGraph(s)
      drawLane(t, s)
      drawEnvelope(t)
      house.words(names, bottom, loop(t), o.frame)
      house.note(s.e.note, R, 480)
      house.hud(t, o.frame, `P ${s.p.toFixed(3)}`, `EASE ${s.i + 1} / ${EASES.length}`)
      return [{ color: canvas }]
    },
    status(t) {
      return at(t).e.name
    },
    inspect(t) {
      const s = at(t)
      return { id: 'eases', ease: s.e.name, u: s.u, progress: s.p, envelope: env(t) }
    },
  }
}

export default preview
