// camera-ken-burns: a plain still made here (a grey figure on a checker ground under a row of
// lights) and three boxes on it, as an analyser would give them. The loop pushes in from the whole
// still to the head, pans to the hand, pulls out to the wide row of lights and back to the whole
// still, each move eased by motion-eases and placed by the plugin. The big picture is the
// 16:9 crop it gives; the target box is drawn dashed in it, with red ticks at the eye line. Bottom
// left, the whole still with the view in red. The move and its target are the big words
// (house.ts).

import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import { progress } from '../../previews/src/motion/eases.ts'
import { type Box, type Framing, moveOf, type View } from '../../previews/src/motion/ken-burns.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = 48
const R = 1032
const ASPECT = 16 / 9
const FRAME = { x: L, y: 150, width: R - L, height: (R - L) / ASPECT }
const STILL = { width: 1600, height: 1400 }
const MAP = { x: L, y: 718, scale: 130 / STILL.height }
const EYE = 0.42

const HEAD: Box = [940, 300, 220, 220]
const HAND: Box = [500, 700, 110, 110]
const ROW: Box = [160, 860, 1280, 80]
const FULL: Framing = { on: 'full' }

const MOVES: {
  from: number
  to: number
  a: Framing
  b: Framing
  move: string
  target: string
  note: string
}[] = [
  {
    from: 0,
    to: 1.5,
    a: FULL,
    b: { on: HEAD, fill: 0.45 },
    move: 'PUSH IN',
    target: 'HEAD',
    note: 'in at one even speed: the width goes in log space',
  },
  {
    from: 1.5,
    to: 3,
    a: { on: HEAD, fill: 0.45 },
    b: { on: HAND, fill: 0.4 },
    move: 'PAN',
    target: 'HAND',
    note: 'across, the box held on the eye line',
  },
  {
    from: 3,
    to: 4.5,
    a: { on: HAND, fill: 0.4 },
    b: { on: ROW },
    move: 'PULL OUT',
    target: 'WIDE',
    note: 'a wide box widens the view, to 92% of its width',
  },
  {
    from: 4.5,
    to: 6,
    a: { on: ROW },
    b: FULL,
    move: 'PULL OUT',
    target: 'FULL',
    note: 'back to the whole still, never past its edge',
  },
]

const cameraKenBurns: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`camera-ken-burns has no state "${stateId}"`)
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The still: drawn once, a stand-in subject with nothing in it that moves.
  const still = host.io.canvas(STILL.width, STILL.height)
  const s = still.getContext('2d') as OffscreenCanvasRenderingContext2D
  const cell = 80
  for (let y = 0; y < STILL.height / cell; y++)
    for (let x = 0; x < STILL.width / cell; x++) {
      s.fillStyle = (x + y) % 2 ? '#2e2e2e' : '#222'
      s.fillRect(x * cell, y * cell, cell, cell)
    }
  s.font = `16px ${mono}`
  s.fillStyle = '#555'
  for (let y = 0; y < STILL.height / cell; y += 2)
    for (let x = 0; x < STILL.width / cell; x += 2)
      s.fillText(`${x}.${y}`, x * cell + 6, y * cell + 20)
  s.fillStyle = '#8a8a8a'
  s.strokeStyle = '#fff'
  s.lineWidth = 4
  s.beginPath()
  s.arc(HEAD[0] + HEAD[2] / 2, HEAD[1] + HEAD[3] / 2, HEAD[2] / 2, 0, Math.PI * 2)
  s.fill()
  s.stroke()
  s.fillStyle = '#5a5a5a'
  s.fillRect(900, 540, 300, 320)
  s.strokeRect(900, 540, 300, 320)
  s.lineWidth = 26
  s.strokeStyle = '#5a5a5a'
  s.beginPath()
  s.moveTo(910, 580)
  s.lineTo(HAND[0] + HAND[2] / 2, HAND[1] + HAND[3] / 2)
  s.stroke()
  s.fillStyle = '#c8c8c8'
  s.beginPath()
  s.arc(HAND[0] + HAND[2] / 2, HAND[1] + HAND[3] / 2, HAND[2] / 2, 0, Math.PI * 2)
  s.fill()
  for (let i = 0; i < 16; i++) {
    s.fillStyle = i % 4 === 0 ? '#fff' : '#9a9a9a'
    s.beginPath()
    s.arc(ROW[0] + (i + 0.5) * (ROW[2] / 16), ROW[1] + ROW[3] / 2, 22, 0, Math.PI * 2)
    s.fill()
  }

  const moveAt = (t: number) =>
    MOVES.find((m) => t < m.to) ?? (MOVES[MOVES.length - 1] as (typeof MOVES)[0])
  const viewAt = (t: number) => {
    const m = moveAt(t)
    return { m, v: moveOf(STILL, m.a, m.b, progress(t, m.from, m.to), ASPECT) }
  }

  /** A box of the still, in the frame of view v. */
  const inFrame = ([bx, by, bw, bh]: Box, v: View) => {
    const k = FRAME.width / v.width
    return [FRAME.x + (bx - v.x) * k, FRAME.y + (by - v.y) * k, bw * k, bh * k] as const
  }

  const drawFrame = (v: View, m: (typeof MOVES)[0]) => {
    ctx.drawImage(still, v.x, v.y, v.width, v.height, FRAME.x, FRAME.y, FRAME.width, FRAME.height)
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.lineWidth = 1
    ctx.strokeRect(FRAME.x, FRAME.y, FRAME.width, FRAME.height)
    ctx.save()
    ctx.beginPath()
    ctx.rect(FRAME.x, FRAME.y, FRAME.width, FRAME.height)
    ctx.clip()
    if (m.b.on !== 'full') {
      ctx.setLineDash([8, 8])
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.strokeRect(...inFrame(m.b.on, v))
      ctx.setLineDash([])
    }
    ctx.restore()
    // The eye line: where a box's centre sits, from the frame's top.
    const ey = FRAME.y + EYE * FRAME.height
    ctx.fillStyle = RED
    ctx.fillRect(FRAME.x - 14, ey - 1, 28, 3)
    ctx.fillRect(R - 14, ey - 1, 28, 3)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'right'
    ctx.fillText(`EYE ${EYE}`, R - 18, ey - 8)
  }

  const drawMap = (v: View) => {
    const k = MAP.scale
    ctx.drawImage(still, MAP.x, MAP.y, STILL.width * k, STILL.height * k)
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth = 1
    ctx.strokeRect(MAP.x, MAP.y, STILL.width * k, STILL.height * k)
    for (const [bx, by, bw, bh] of [HEAD, HAND, ROW])
      ctx.strokeRect(MAP.x + bx * k, MAP.y + by * k, bw * k, bh * k)
    ctx.strokeStyle = RED
    ctx.lineWidth = 2
    ctx.strokeRect(MAP.x + v.x * k, MAP.y + v.y * k, v.width * k, v.height * k)
  }

  const moves: Word[] = MOVES.map((m) => ({ from: m.from, to: m.to, text: m.move }))
  const targets: Word[] = MOVES.map((m) => ({ from: m.from, to: m.to, text: m.target }))

  return {
    async render(t, o) {
      const { m, v } = viewAt(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      drawFrame(v, m)
      drawMap(v)
      house.words(moves, targets, t, o.frame)
      house.note(m.note, R, 790)
      house.hud(
        t,
        o.frame,
        `VIEW ${v.width.toFixed(0)}×${v.height.toFixed(0)} AT ${v.x.toFixed(0)},${v.y.toFixed(0)}`,
        `ZOOM ×${(STILL.width / v.width).toFixed(2)}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return `${moveAt(t).move} > ${moveAt(t).target}`
    },
    inspect(t) {
      const { m, v } = viewAt(t)
      return { id: 'view', move: m.move, target: m.target, ...v }
    },
  }
}

export default cameraKenBurns
