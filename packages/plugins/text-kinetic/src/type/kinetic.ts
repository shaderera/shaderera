// Text that moves like data: scrambled through ASCII, decoded into place, cut into bands that are
// thrown sideways, and sized to fit. Canvas2D only, the same in the browser and in Node. Every
// choice comes from a hash of the frame and the character, never from Math.random, so a frame
// renders the same every time.

type Ctx = OffscreenCanvasRenderingContext2D

/** A 32-bit hash (PCG). */
export const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
/** A hash as a number in [0, 1). */
export const rnd = (v: number) => hash(v) / 4294967296

export const GLYPHS = '0123456789#$%&@*+=<>/\\|!?:;ABCDEFXZ'
const noise = (v: number, glyphs: string) => glyphs[hash(v) % glyphs.length] ?? '#'

/** Each character is replaced by noise on this frame with probability `share`. */
export const scramble = (text: string, frame: number, share: number, glyphs = GLYPHS) =>
  [...text]
    .map((ch, i) =>
      ch !== ' ' && rnd(frame * 131 + i * 7) < share ? noise(frame * 977 + i * 31, glyphs) : ch,
    )
    .join('')

/**
 * Text that decodes into place character by character over its first `rise` seconds, and
 * scrambles away over its last `fall` seconds, between `from` and `to`. Out of nothing, or with
 * `swap`, out of ASCII noise (for text replacing other text). `settled` is true while all of it
 * reads.
 */
export const decoded = (
  text: string,
  t: number,
  o: {
    from: number
    to: number
    frame: number
    seed?: number
    rise?: number
    fall?: number
    swap?: boolean
    glyphs?: string
  },
) => {
  const seed = o.seed ?? 0
  const inn = (t - o.from) / (o.rise ?? 0.3)
  const out = (o.to - t) / (o.fall ?? 0.15)
  const chars = [...text].map((ch, i) => {
    if (ch === ' ') return ch
    const h = rnd(seed * 7919 + i * 13)
    if (inn > h && out > h) return ch
    return o.swap || (inn > h * 0.4 && out > h * 0.4)
      ? noise(o.frame * 977 + i * 31 + seed, o.glyphs ?? GLYPHS)
      : ' '
  })
  return { text: chars.join(''), settled: Math.min(inn, out) > 1, visible: t >= o.from && t < o.to }
}

export type Draw = (ctx: Ctx, text: string, x: number, y: number) => void

/** Fills text in the current fillStyle. */
export const fill: Draw = (ctx, text, x, y) => ctx.fillText(text, x, y)

/**
 * Text cut into horizontal bands, each thrown sideways by its own amount on each frame. `font` is
 * a font family alone ('"IBM Plex Mono SemiBold"'): the size goes in front of it, so a weight there
 * would not parse; register each weight as its own family. `amount` 0 draws it whole, 1 is a hard
 * glitch. `draw` paints one band (fill by default; stroke for outlines).
 */
export const glitched = (
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  o: {
    font: string
    size: number
    frame: number
    align?: CanvasTextAlign
    amount?: number
    bands?: number
    draw?: Draw
  },
) => {
  ctx.font = `${o.size}px ${o.font}`
  ctx.textAlign = o.align ?? 'left'
  ctx.textBaseline = 'middle'
  const draw = o.draw ?? fill
  const amount = o.amount ?? 1
  if (amount <= 0) {
    draw(ctx, text, x, y)
    return
  }
  const bands = o.bands ?? 7
  const top = y - o.size * 0.45
  const h = (o.size * 0.9) / bands
  for (let b = 0; b < bands; b++) {
    const thrown = rnd(o.frame * 53 + b * 11) < 0.45 * amount
    const shift = thrown ? (rnd(o.frame * 17 + b * 5) - 0.5) * o.size * 0.35 : 0
    ctx.save()
    ctx.beginPath()
    ctx.rect(-ctx.canvas.width, top + b * h, 3 * ctx.canvas.width, h + 1)
    ctx.clip()
    draw(ctx, text, x + shift, y)
    ctx.restore()
  }
}

/** The size at which `text` in `font` (a family alone, as in glitched) is `width` wide. */
export const fitWidth = (ctx: Ctx, font: string, text: string, width: number) => {
  ctx.font = `100px ${font}`
  return (100 * width) / Math.max(1, ctx.measureText(text).width)
}

/** `size`, or smaller if text at that size would be wider than `room`. */
export const fitSize = (ctx: Ctx, font: string, text: string, size: number, room: number) =>
  Math.min(size, fitWidth(ctx, font, text, room))

/** Outlined text, for a number or word set huge and quiet behind the rest. */
export const hollow = (
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  o: {
    font: string
    size: number
    align?: CanvasTextAlign
    baseline?: CanvasTextBaseline
    color?: string
    width?: number
  },
) => {
  ctx.font = `${o.size}px ${o.font}`
  ctx.textAlign = o.align ?? 'left'
  ctx.textBaseline = o.baseline ?? 'alphabetic'
  ctx.lineWidth = o.width ?? 1.2
  ctx.strokeStyle = o.color ?? 'rgba(255,255,255,0.28)'
  ctx.strokeText(text, x, y)
}

/** Seconds as `SS.mmm`. */
export const timecode = (t: number) => {
  const s = Math.max(0, t)
  return `${String(Math.floor(s)).padStart(2, '0')}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`
}
