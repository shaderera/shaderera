// The ground truth review-shots is measured against: a film made in code from a seed, as a
// Shaderera source (the same frame for the same t), whose every frame's truth is known. Each shot
// is a field of points and rings twice the frame each way, seen through a camera with a known move:
// zoom in % a second (compounded, or eased as the films ease a push, then held) and pan in frame
// widths a second, x right and y down. It holds hard cuts, 4-frame shots, a flash, a dip, a long
// dissolve, pushes, pulls, pans and tilts on stills, an eased push under a still label, a fast
// eased zoom to twice the size, a push over moving content, a very slow push, and a subject moving
// in a static frame. Then gradual transitions over moving content, eased as the films ease them
// (dissolves of 0.4 and 0.8 s, and a card swapped over footage that keeps playing, where 15 % of
// the frame changes), and the cases that read as false cuts: a fast push over dense footage that
// drops every sixth frame (footage made at 30 fps shown at 25), a fast eased pull out over a wall of
// prints, and a push on a dark still while a spotlight closes in under a label. Then cards over a
// soft, dim picture that keeps playing, as films lay an artwork over footage, where the card is the
// shot: one crossfaded to the next and one swapped at once (new shots), and one under which the rest
// goes dark as a spotlight switches on (no new shot); a dissolve between two pictures of low
// contrast; and a still that fades to black at the end (no new shot).

import { Canvas } from '@napi-rs/canvas'

export const FPS = 30
export const W = 480
export const H = 270

type Enter = 'cut' | { dissolve: number; eased?: boolean } | { dip: number } | { flash: number }
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
  /** A card held still over the picture, 11 to 15 % of the frame (see CARDS). */
  card?: number
  /** The picture goes on from the shot before (its world and its time): only the card changes. */
  continues?: boolean
  /** The picture soft and dim under its card, as a film lays an artwork over footage. */
  soft?: boolean
  /** From this second, a spotlight switches on over the card: the rest goes dark in 0.2 s. */
  dim?: number
  /** The picture at this contrast (1 is the world's own), around mid grey. */
  contrast?: number
  /** The shot's last frames fade to black over the first number and hold black for the second. */
  fadeOut?: [number, number]
  /** Made at 36 fps and shown at 30: a frame is dropped every fifth frame. */
  drop?: boolean
  /** Fine dense strokes (a field), or a wall of coloured prints, over the points. */
  texture?: 'field' | 'prints'
  /** A dark picture, and a spotlight on it that closes in fast and darkens the rest. */
  spot?: boolean
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
  // Gradual transitions over moving content, each shot's move at one rate.
  { frames: 45, enter: 'cut', content: 'footage', zoom: 6, pan: [0, 0] },
  { frames: 60, enter: { dissolve: 12, eased: true }, content: 'footage', zoom: 0, pan: [0.1, 0] },
  { frames: 60, enter: { dissolve: 24, eased: true }, content: 'footage', zoom: -5, pan: [0, 0] },
  { frames: 45, enter: 'cut', content: 'footage', zoom: 0, pan: [0, 0], card: 0 },
  {
    frames: 45,
    enter: { dissolve: 12, eased: true },
    content: 'footage',
    zoom: 0,
    pan: [0, 0],
    card: 1,
    continues: true,
  },
  { frames: 45, enter: { dissolve: 12, eased: true }, content: 'still', zoom: 4, pan: [0, 0] },
  // No cut inside any of these.
  {
    frames: 60,
    enter: 'cut',
    content: 'footage',
    zoom: 4,
    pan: [0.05, 0],
    drop: true,
    texture: 'field',
  },
  {
    frames: 75,
    enter: 'cut',
    content: 'still',
    zoom: 0,
    pan: [0, 0],
    scale: 3.2,
    eased: [1 / 3.2, 1.6],
    texture: 'prints',
  },
  { frames: 40, enter: 'cut', content: 'still', zoom: 3.2, pan: [0, 0], label: true, spot: true },
  { frames: 30, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0] },
  // Cards over a soft picture that keeps playing: each card is a shot, crossfaded or swapped at once.
  { frames: 45, enter: 'cut', content: 'footage', zoom: 0, pan: [0, 0], card: 2, soft: true },
  {
    frames: 45,
    enter: { dissolve: 10, eased: true },
    content: 'footage',
    zoom: 0,
    pan: [0, 0],
    card: 3,
    soft: true,
    continues: true,
  },
  {
    frames: 45,
    enter: 'cut',
    content: 'footage',
    zoom: 0,
    pan: [0, 0],
    card: 4,
    soft: true,
    continues: true,
  },
  // No cut inside: a spotlight switches on over a card.
  {
    frames: 50,
    enter: 'cut',
    content: 'footage',
    zoom: 0,
    pan: [0, 0],
    texture: 'prints',
    card: 5,
    dim: 0.8,
  },
  // A dissolve between two pictures of low contrast.
  { frames: 40, enter: 'cut', content: 'footage', zoom: 0, pan: [0, 0], contrast: 0.2 },
  {
    frames: 45,
    enter: { dissolve: 10, eased: true },
    content: 'footage',
    zoom: 0,
    pan: [0, 0],
    contrast: 0.2,
  },
  // The end: a still that fades to black and holds black, which is no new shot.
  { frames: 60, enter: 'cut', content: 'still', zoom: 0, pan: [0, 0], fadeOut: [25, 10] },
]
/** The shots made before #81: the shots after them draw from the seed after the subject and the
 * first two cards, so the film's first 40 s stay frame for frame as they were. */
const FIRST = 27

/** Each shot's truth: its cut (the first frame it shows), its transition (the frames from the cut
 * until the old shot is gone; a dip and a flash count from the first frame they change), and its
 * move. */
export type Truth = {
  cut: number
  end: number
  transition: [number, number] | null
  dissolve: boolean
  /** A spotlight closes in on a dark picture under a label. */
  spot: boolean
  content: Content
  zoom: number
  pan: [number, number]
}

const ease = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, p)))
/** The picture's scale t seconds into its shot. */
const scaleAt = (p: Plan, t: number) =>
  (p.scale ?? 1) * (p.eased ? p.eased[0] ** ease(t / p.eased[1]) : (1 + p.zoom / 100) ** t)
/** The picture's time: seconds since its shot began (or the shot it goes on from), at 36 fps
 * where frames are dropped. */
const timeOf = (p: Plan, f: number, cut: number) =>
  p.drop ? Math.floor(((f - cut) * 36) / FPS) / 36 : (f - cut) / FPS

/** The shot whose picture each shot shows: its own, or the one it goes on from. */
const BASE: number[] = []
for (const [k, p] of PLAN.entries()) BASE.push(p.continues ? (BASE[k - 1] as number) : k)

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
  const last = timeOf(p, at - 1, cut)
  const zoom = ((scaleAt(p, last) / scaleAt(p, 0)) ** (1 / seconds) - 1) * 100
  const pan: [number, number] = [(p.pan[0] * last) / seconds, (p.pan[1] * last) / seconds]
  const dissolve = e !== 'cut' && 'dissolve' in e
  return {
    cut,
    end: at,
    transition,
    dissolve,
    spot: p.spot === true,
    content: p.content,
    zoom,
    pan,
  }
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
const makeWorld = (p: Plan, k: number) => {
  const world = new Canvas(W * 2, H * 2)
  const g = world.getContext('2d') as unknown as CanvasRenderingContext2D
  const hue = (k * 137) % 360
  g.fillStyle = `hsl(${hue} 30% ${p.spot ? 5 : 12}%)`
  g.fillRect(0, 0, W * 2, H * 2)
  scatter(g, W * 2, H * 2, 1400, `hsl(${hue} 60% ${p.spot ? 30 : 75}%)`)
  if (p.texture === 'field')
    for (let i = 0; i < 9000; i++) {
      g.strokeStyle = `hsl(${40 + rand() * 20} 60% ${20 + rand() * 60}%)`
      const x = rand() * W * 2
      const y = rand() * H * 2
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x + (rand() - 0.5) * 8, y - 10 - rand() * 30)
      g.stroke()
    }
  if (p.texture === 'prints')
    for (let i = 0; i < 1500; i++) {
      const [x, y, w, h] = [rand() * W * 2, rand() * H * 2, 12 + rand() * 30, 12 + rand() * 30]
      g.fillStyle = `hsl(${rand() * 360} ${30 + rand() * 50}% ${15 + rand() * 75}%)`
      g.fillRect(x, y, w, h)
      for (let j = 0; j < 3; j++) {
        g.fillStyle = `hsl(${rand() * 360} ${30 + rand() * 50}% ${15 + rand() * 75}%)`
        g.fillRect(
          x + rand() * w * 0.7,
          y + rand() * h * 0.7,
          2 + rand() * w * 0.3,
          2 + rand() * h * 0.3,
        )
      }
    }
  const blobs = Array.from({ length: 40 }, () => ({
    x: rand() * W * 2,
    y: rand() * H * 2,
    r: 10 + rand() * 25,
    vx: (rand() - 0.5) * 0.4 * W,
    vy: (rand() - 0.5) * 0.4 * W,
    l: 30 + rand() * 50,
  }))
  return { world, hue, blobs }
}
const WORLDS = PLAN.slice(0, FIRST).map(makeWorld)
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
/** A card: a light ground and its own marks, at its place in the frame, with a credit line under
 * it or not. */
type Card = { canvas: Canvas; x: number; y: number; credit: boolean }
const card = (
  [w, h]: [number, number],
  ground: string,
  ink: string,
  marks: number,
  [x, y]: [number, number],
  credit: boolean,
) => {
  const c = new Canvas(w, h)
  const g = c.getContext('2d') as unknown as CanvasRenderingContext2D
  g.fillStyle = ground
  g.fillRect(0, 0, w, h)
  scatter(g, w, h, marks, ink)
  return { canvas: c, x, y, credit }
}
/** Two cards of 15 % of the frame over sharp footage, then four of 11 to 15 % in the middle of a
 * soft picture, each with its credit, as films show an artwork. */
const CARDS: Card[] = [
  card([180, 108], '#e8dcc8', '#522', 160, [W * 0.55, H * 0.45], false),
  card([180, 108], '#c8d8e8', '#235', 160, [W * 0.55, H * 0.45], false),
]
WORLDS.push(...PLAN.slice(FIRST).map((p, k) => makeWorld(p, FIRST + k)))
CARDS.push(
  ...(
    [
      [110, 176, '#e6d6b8', '#3a2410'],
      [96, 150, '#dfe6da', '#16261a'],
      [150, 130, '#e9d8d0', '#3a1420'],
      [120, 160, '#d8dce8', '#141a3a'],
    ] as const
  ).map(([w, h, ground, ink]) =>
    card([w, h], ground, ink, Math.round((w * h) / 120), [(W - w) / 2, H * 0.42 - h / 2], true),
  ),
)

const picture = (k: number, f: number) => {
  const shot = SHOTS[k] as Truth
  const plan = PLAN[k] as Plan
  const base = BASE[k] as number
  const { world, hue, blobs } = WORLDS[base] as ReturnType<typeof makeWorld>
  const t = timeOf(plan, f, (SHOTS[base] as Truth).cut)
  const s = scaleAt(plan, t)
  const cx = W + shot.pan[0] * W * t
  const cy = H + shot.pan[1] * W * t
  const c = new Canvas(W, H)
  const g = c.getContext('2d') as unknown as CanvasRenderingContext2D
  g.setTransform(s, 0, 0, s, W / 2 - s * cx, H / 2 - s * cy)
  if (plan.soft) g.filter = 'blur(5px) brightness(60%)'
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
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.filter = 'none'
  if (plan.contrast !== undefined) {
    g.globalAlpha = 1 - plan.contrast
    g.fillStyle = '#808080'
    g.fillRect(0, 0, W, H)
    g.globalAlpha = 1
  }
  if (plan.dim !== undefined) {
    g.globalAlpha = 0.9 * ease((t - plan.dim) / 0.2)
    g.fillStyle = '#000'
    g.fillRect(0, 0, W, H)
    g.globalAlpha = 1
  }
  if (plan.spot) {
    // A spotlight on a point of the picture, closing in from 0.2 s for 0.4 s while the rest goes
    // dark.
    const p = ease((t - 0.2) / 0.4)
    const x = W / 2 + s * (1.2 * W - cx)
    const y = H / 2 + s * (0.9 * H - cy)
    const r = W * (0.9 - 0.75 * p)
    const light = g.createRadialGradient(x, y, r * 0.5, x, y, r)
    light.addColorStop(0, 'rgba(0,0,0,0)')
    light.addColorStop(1, `rgba(0,0,0,${0.92 * p})`)
    g.fillStyle = light
    g.fillRect(0, 0, W, H)
  }
  if (plan.card !== undefined) {
    const c = CARDS[plan.card] as Card
    g.drawImage(c.canvas as unknown as CanvasImageSource, c.x, c.y)
    if (c.credit) {
      // Its credit line, centred under it, in a word pattern of its own.
      g.fillStyle = '#eee'
      const n = plan.card
      const words = Array.from({ length: 4 + n }, (_, i) => 8 + ((i * n * 7) % 13))
      let x = W / 2 - (words.reduce((a, b) => a + b + 5, 0) - 5) / 2
      for (const w of words) {
        g.fillRect(x, c.y + c.canvas.height + 12, w, 6)
        x += w + 5
      }
    }
  }
  if (plan.label) {
    // A credit line of words, as films lay one over a still.
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
  const p = dissolving ? (f - shot.cut + 1) / (enter.dissolve + 1) : 1
  g.globalAlpha = dissolving && enter.eased ? ease(p) : p
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
  const fade = PLAN[k]?.fadeOut
  if (fade)
    fill('#000', Math.min(1, Math.max(0, (f - (shot.end - fade[1] - fade[0]) + 1) / fade[0])))
  return g.getImageData(0, 0, W, H).data
}

/** Frame f's truth: its shot, numbered from 1, and whether a transition is running. */
export const inspect = (time: number) => {
  const f = Math.round(time * FPS)
  const k = SHOTS.findLastIndex((s) => s.cut <= f)
  const s = SHOTS[k] as Truth
  return { shot: k + 1, zoom: s.zoom, pan: s.pan, transition: s.transition !== null }
}
