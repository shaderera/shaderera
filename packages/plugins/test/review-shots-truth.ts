// The ground truth review-shots is measured against: a film made in code from a seed, as a
// Shaderera source (the same frame for the same t), whose every frame's truth is known. Each shot
// is a field of points and rings twice the frame each way, seen through a camera with a known move:
// zoom in % a second (compounded, or eased as the films ease a push, then held) and pan in frame
// widths a second, x right and y down. It holds hard cuts, 4-frame shots, a flash, a dip, a long
// dissolve, pushes, pulls, pans and tilts on stills, an eased push under a still label, a fast
// eased zoom to twice the size, a push over moving content, a very slow push, and a subject moving
// in a static frame.

import { Canvas } from '@napi-rs/canvas'

export const FPS = 30
export const W = 480
export const H = 270

type Enter = 'cut' | { dissolve: number } | { dip: number } | { flash: number }
type Content = 'still' | 'footage' | 'subject'
type Plan = {
  frames: number
  enter: Enter
  content: Content
  zoom: number
  pan: [number, number]
  scale?: number
  /** An eased zoom instead: this much in all over these seconds (cosine ease, in log space), then
   * held to the end of the shot. */
  eased?: [number, number]
  /** A label that does not move, over the picture. */
  label?: boolean
}

const PLAN: Plan[] = [
  { frames: 30, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0] },
  { frames: 45, enter: 'cut', content: 'still', zoom: 15, pan: [0, 0] },
  { frames: 4, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0] },
  { frames: 4, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0] },
  { frames: 4, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0] },
  { frames: 45, enter: 'cut', content: 'still', zoom: 0, pan: [0.2, 0] },
  { frames: 45, enter: { flash: 2 }, content: 'still', zoom: 0, pan: [0, 0.15] },
  { frames: 45, enter: { dip: 10 }, content: 'still', zoom: -12, pan: [0, 0], scale: 1.2 },
  // The dissolve's two shots hold still: how a move reads across one is #75's.
  { frames: 40, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0] },
  { frames: 60, enter: { dissolve: 30 }, content: 'still', zoom: 0, pan: [0, 0] },
  { frames: 45, enter: 'cut', content: 'still', zoom: 0, pan: [-0.12, 0] },
  {
    frames: 39,
    enter: 'cut',
    content: 'still',
    zoom: 0,
    pan: [0, 0],
    eased: [1.05, 1],
    label: true,
  },
  { frames: 60, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0], eased: [2, 1.2] },
  { frames: 60, enter: 'cut', content: 'footage', zoom: 10, pan: [0, 0] },
  { frames: 90, enter: 'cut', content: 'still', zoom: 0.5, pan: [0, 0] },
  { frames: 60, enter: 'cut', content: 'subject', zoom: 0, pan: [0, 0] },
  { frames: 30, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0] },
]

/** Each shot's truth: its cut (the first frame it shows), its transition (the frames from the cut
 * until the old shot is gone; a dip and a flash count from the first frame they change), and its
 * move. */
export type Truth = {
  cut: number
  end: number
  transition: [number, number] | null
  dissolve: boolean
  content: Content
  zoom: number
  pan: [number, number]
}

const ease = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, p)))
/** The picture's scale t seconds into its shot. */
const scaleAt = (p: Plan, t: number) =>
  p.eased ? p.eased[0] ** ease(t / p.eased[1]) : (p.scale ?? 1) * (1 + p.zoom / 100) ** t

let at = 0
export const SHOTS: Truth[] = PLAN.map((p) => {
  const cut = at
  at += p.frames
  const e = p.enter
  const transition: [number, number] | null =
    e === 'cut'
      ? null
      : 'dissolve' in e
        ? [cut, cut + e.dissolve - 1]
        : 'dip' in e
          ? [cut - e.dip, cut + e.dip - 1]
          : [cut - e.flash, cut + e.flash - 1]
  // The zoom a viewer sees: from the shot's first frame to its last, over the time between them.
  const seconds = (p.frames - 1) / FPS
  const zoom = ((scaleAt(p, seconds) / scaleAt(p, 0)) ** (1 / seconds) - 1) * 100
  const dissolve = e !== 'cut' && 'dissolve' in e
  return { cut, end: at, transition, dissolve, content: p.content, zoom, pan: p.pan }
})
export const FRAMES = at

let seed = 0x5eed
const rand = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
  return seed / 4294967296
}

const scatter = (g: CanvasRenderingContext2D, w: number, h: number, n: number, ink: string) => {
  g.fillStyle = ink
  g.strokeStyle = ink
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.3 + 0.7 * rand()
    g.beginPath()
    g.arc(rand() * w, rand() * h, 1 + rand() ** 3 * 9, 0, Math.PI * 2)
    if (i % 5) g.fill()
    else g.stroke()
  }
  g.globalAlpha = 1
}

/** Each shot's world, a new scatter in its own grade; footage's blobs drift across it, and a
 * subject crosses the subject shot, both in the world's own coordinates. */
const WORLDS = PLAN.map((_, k) => {
  const world = new Canvas(W * 2, H * 2)
  const g = world.getContext('2d') as unknown as CanvasRenderingContext2D
  const hue = (k * 137) % 360
  g.fillStyle = `hsl(${hue} 30% 12%)`
  g.fillRect(0, 0, W * 2, H * 2)
  scatter(g, W * 2, H * 2, 1400, `hsl(${hue} 60% 75%)`)
  const blobs = Array.from({ length: 40 }, () => ({
    x: rand() * W * 2,
    y: rand() * H * 2,
    r: 10 + rand() * 25,
    vx: (rand() - 0.5) * 0.4 * W,
    vy: (rand() - 0.5) * 0.4 * W,
    l: 30 + rand() * 50,
  }))
  return { world, hue, blobs }
})
const SUBJECT = (() => {
  const c = new Canvas(140, 140)
  const g = c.getContext('2d') as unknown as CanvasRenderingContext2D
  g.beginPath()
  g.arc(70, 70, 70, 0, Math.PI * 2)
  g.clip()
  g.fillStyle = '#c84'
  g.fillRect(0, 0, 140, 140)
  scatter(g, 140, 140, 120, '#fff')
  return c
})()

const picture = (k: number, f: number) => {
  const shot = SHOTS[k] as Truth
  const plan = PLAN[k] as Plan
  const { world, hue, blobs } = WORLDS[k] as (typeof WORLDS)[number]
  const t = (f - shot.cut) / FPS
  const s = scaleAt(plan, t)
  const cx = W + shot.pan[0] * W * t
  const cy = H + shot.pan[1] * W * t
  const c = new Canvas(W, H)
  const g = c.getContext('2d') as unknown as CanvasRenderingContext2D
  g.setTransform(s, 0, 0, s, W / 2 - s * cx, H / 2 - s * cy)
  g.drawImage(world as unknown as CanvasImageSource, 0, 0)
  if (shot.content === 'footage') {
    for (const b of blobs) {
      g.fillStyle = `hsl(${hue} 50% ${b.l + 10 * Math.sin(t * 7 + b.r)}%)`
      g.beginPath()
      g.arc(b.x + b.vx * t, b.y + b.vy * t, b.r, 0, Math.PI * 2)
      g.fill()
    }
  }
  if (shot.content === 'subject') {
    g.translate(W / 2 + (t - 1) * 0.4 * W, H + 40 * Math.sin(t * 3))
    g.rotate(t)
    g.drawImage(SUBJECT as unknown as CanvasImageSource, -70, -70)
  }
  if (plan.label) {
    // A credit line of words, as films lay one over a still.
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.fillStyle = '#fff'
    for (let i = 0, x = 12; i < 14; i++, x += 14 + ((i * 7) % 13))
      g.fillRect(x, 14, 10 + ((i * 5) % 9), 9)
    for (let i = 0, x = 12; i < 9; i++, x += 12 + ((i * 5) % 11))
      g.fillRect(x, 28, 8 + ((i * 3) % 7), 5)
  }
  return c
}

/** Frame f: the shot it belongs to, over the shot before while a transition runs. */
export const render = (time: number): Uint8ClampedArray => {
  const f = Math.round(time * FPS)
  const k = SHOTS.findLastIndex((s) => s.cut <= f)
  const out = new Canvas(W, H)
  const g = out.getContext('2d') as unknown as CanvasRenderingContext2D
  const next = SHOTS[k + 1]
  const enter = PLAN[k]?.enter
  const leave = PLAN[k + 1]?.enter
  const shot = SHOTS[k] as Truth
  const dissolving =
    enter && enter !== 'cut' && 'dissolve' in enter && f < shot.cut + enter.dissolve
  // While a dissolve runs, the old shot, still moving, under the new one coming in.
  if (dissolving) g.drawImage(picture(k - 1, f) as unknown as CanvasImageSource, 0, 0)
  g.globalAlpha = dissolving ? (f - shot.cut + 1) / (enter.dissolve + 1) : 1
  g.drawImage(picture(k, f) as unknown as CanvasImageSource, 0, 0)
  g.globalAlpha = 1
  const fill = (colour: string, alpha: number) => {
    g.globalAlpha = alpha
    g.fillStyle = colour
    g.fillRect(0, 0, W, H)
    g.globalAlpha = 1
  }
  if (enter && enter !== 'cut' && 'dip' in enter && f < shot.cut + enter.dip)
    fill('#000', 1 - (f - shot.cut + 1) / (enter.dip + 1))
  if (enter && enter !== 'cut' && 'flash' in enter && f < shot.cut + enter.flash)
    fill('#fff', (shot.cut + enter.flash - f) / (enter.flash + 1))
  if (next && leave && leave !== 'cut' && 'dip' in leave && f >= next.cut - leave.dip)
    fill('#000', (f - next.cut + leave.dip + 1) / leave.dip)
  if (next && leave && leave !== 'cut' && 'flash' in leave && f >= next.cut - leave.flash)
    fill('#fff', (f - next.cut + leave.flash + 1) / (leave.flash + 1))
  return g.getImageData(0, 0, W, H).data
}

/** Frame f's truth: its shot, numbered from 1, and whether a transition is running. */
export const inspect = (time: number) => {
  const f = Math.round(time * FPS)
  const k = SHOTS.findLastIndex((s) => s.cut <= f)
  const s = SHOTS[k] as Truth
  return { shot: k + 1, zoom: s.zoom, pan: s.pan, transition: s.transition !== null }
}
