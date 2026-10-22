// Glitch titles: a huge title and a small note, several to a scene, each held for `swap`
// seconds and swapping to the next through ASCII noise. Each one is set somewhere new, in turn,
// in one of four compositions on the frame's safe area, with its number huge and hollow behind
// it. Name what the picture is doing while it does it.

import type { Json } from '@shaderera/core'
import { type Platform, safeArea } from '../layout/frame.ts'
import { fitSize } from './fit.ts'
import { decoded, glitched, hollow } from './scramble.ts'

type Ctx = OffscreenCanvasRenderingContext2D

/**
 * A title card: its items shown in turn from `start` to `end`. An `id` names it in inspect (and is
 * what the source stamp marks).
 */
export type Title = {
  id?: string
  start: number
  end: number
  items: [title: string, note: string][]
}
/** What `inspect(t)` reports for a title showing at t. */
export type TitleState = {
  /** The title's own fields but its items: `id`, `start`, `end`, the stamp's `source`, any other. */
  [field: string]: Json
  /** The item showing, its place among all the titles' items, and its layout. */
  item: number
  index: number
  title: string
  note: string
  layout: Layout
  /** How far the item's hold has gone, 0 to 1. */
  u: number
}
export type Layout = 'edge' | 'column' | 'spine' | 'split'

export type TitleOptions = {
  titles: Title[]
  /** CSS font families, quoted: '"IBM Plex Mono SemiBold"'. */
  fonts: { title: string; small: string; note: string }
  /** Seconds each item holds before the next swaps in (two beats of the music reads well). */
  swap: number
  layouts?: Layout[]
  platform?: Platform
  /** Show the running number ("03 / 12") and the huge hollow numeral. */
  numbers?: boolean
  colors?: { title: string; small: string; note: string; line: string; hollow: string }
}

export const createTitles = (o: TitleOptions) => {
  const layouts = o.layouts ?? ['edge', 'split', 'column', 'spine']
  const c = o.colors ?? {
    title: 'rgba(255,255,255,0.95)',
    small: 'rgba(222,230,242,0.82)',
    note: 'rgba(232,238,248,0.9)',
    line: 'rgba(222,230,242,0.45)',
    hollow: 'rgba(255,255,255,0.28)',
  }
  const numbers = o.numbers ?? true
  const total = o.titles.reduce((n, x) => n + x.items.length, 0)
  const first = o.titles.map((_, i) => o.titles.slice(0, i).reduce((n, x) => n + x.items.length, 0))
  // The family is the bold face: a weight here would land after the size, an invalid font.
  const bold = o.fonts.title

  const big = (
    ctx: Ctx,
    text: string,
    x: number,
    y: number,
    size: number,
    align: CanvasTextAlign,
    frame: number,
    settled: boolean,
  ) => {
    ctx.fillStyle = c.title
    glitched(ctx, text, x, y, { font: bold, size, frame, align, amount: settled ? 0 : 1 })
  }
  const small = (
    ctx: Ctx,
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
    size: number,
  ) => {
    if (!numbers) return
    ctx.font = `${size}px ${o.fonts.small}`
    ctx.fillStyle = c.small
    ctx.textAlign = align
    ctx.textBaseline = baseline
    ctx.fillText(text, x, y)
  }
  const note = (
    ctx: Ctx,
    text: string,
    x: number,
    y: number,
    size: number,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
  ) => {
    ctx.font = `${size}px ${o.fonts.note}`
    ctx.fillStyle = c.note
    ctx.textAlign = align
    ctx.textBaseline = baseline
    ctx.fillText(text, x, y)
  }
  const line = (ctx: Ctx, x0: number, y0: number, x1: number, y1: number) => {
    ctx.strokeStyle = c.line
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
  const numeral = (
    ctx: Ctx,
    text: string,
    x: number,
    y: number,
    size: number,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
  ) => {
    if (numbers) hollow(ctx, text, x, y, { font: bold, size, align, baseline, color: c.hollow })
  }

  const one = (
    ctx: Ctx,
    W: number,
    H: number,
    layout: Layout,
    title: string,
    text: string,
    count: string,
    number: string,
    u: number,
    frame: number,
    settled: boolean,
  ) => {
    const words = title.split(' ').filter(Boolean)
    const a = safeArea(W, H, o.platform)
    const l = a.left
    const r = a.right
    const top = a.top
    const b = a.bottom
    const span = a.width
    const tall = H > W
    const s = Math.min(W, H) / 1080 // small type and notes scale with the frame
    const smallSize = Math.round(13 * s * (tall ? 1.4 : 1))
    const noteSize = Math.round(30 * s * (tall ? 1.3 : 1))
    const huge = Math.min(H * 0.36, W * 0.42)
    if (layout === 'edge') {
      // Huge along the bottom over a ruler the time runs along; the number top right.
      const size = fitSize(ctx, bold, title, H * 0.16, span)
      const y = H - b - size * 0.42
      const rule = y - size * 0.62
      numeral(ctx, number, W - r, top + 10, huge, 'right', 'top')
      big(ctx, title, l - size * 0.03, y, size, 'left', frame, settled)
      line(ctx, l, rule, W - r, rule)
      for (let k = 0; k <= 32; k++)
        line(ctx, l + (span * k) / 32, rule, l + (span * k) / 32, rule + (k % 4 === 0 ? 9 : 4))
      ctx.fillStyle = c.title
      ctx.fillRect(l + span * Math.min(1, Math.max(0, u)) - 3, rule - 3, 6, 6)
      small(ctx, count, l, rule - 10, 'left', 'bottom', smallSize)
      note(ctx, text, W - r, rule - 8, noteSize, 'right', 'bottom')
    } else if (layout === 'column') {
      // A word to a line, ranged right, a hairline down its left; the number bottom left.
      const size = Math.min(
        ...words.map((w) => fitSize(ctx, bold, w, H * 0.13, tall ? span : W * 0.42)),
      )
      ctx.font = `${size}px ${bold}`
      const wide = Math.max(...words.map((w) => ctx.measureText(w).width))
      const lead = size * 0.98
      const y0 = (top + H - b) / 2 - ((words.length - 1) * lead) / 2
      numeral(ctx, number, l, H - b, huge, 'left', 'bottom')
      words.forEach((w, k) => {
        big(ctx, w, W - r, y0 + k * lead, size, 'right', frame + k * 7, settled)
      })
      const x = Math.max(l, W - r - wide - 26)
      line(ctx, x, y0 - lead * 0.8, x, y0 + (words.length - 1) * lead + lead * 0.8)
      small(ctx, count, W - r, y0 - lead * 0.62, 'right', 'bottom', smallSize)
      note(ctx, text, W - r, y0 + (words.length - 1) * lead + lead * 0.6, noteSize, 'right', 'top')
    } else if (layout === 'spine') {
      // On its end up the left edge, read bottom to top; the number right of centre.
      const size = Math.min(fitSize(ctx, bold, title, H * 0.15, H - top - b), W * 0.2)
      numeral(ctx, number, W - r, (top + H - b) / 2, huge, 'right', 'middle')
      ctx.save()
      ctx.translate(l + size * 0.5, H - b)
      ctx.rotate(-Math.PI / 2)
      big(ctx, title, 0, 0, size, 'left', frame, settled)
      ctx.restore()
      const rx = l + size + 18
      line(ctx, rx, top, rx, H - b)
      small(ctx, count, rx + 14, top, 'left', 'top', smallSize)
      note(ctx, text, rx + 14, H - b, noteSize, 'left', 'bottom')
    } else {
      // The first word top left, the rest bottom right, a diagonal hairline between; the number
      // bottom left.
      const head =
        words.length > 1 ? (words[0] ?? title) : title.slice(0, Math.ceil(title.length / 2))
      const tail =
        words.length > 1 ? words.slice(1).join(' ') : title.slice(Math.ceil(title.length / 2))
      const room = tall ? span : W * 0.62
      const size = Math.min(
        fitSize(ctx, bold, head, H * 0.15, room),
        fitSize(ctx, bold, tail, H * 0.15, room),
      )
      const ya = top + size * 0.5
      const yb = H - b - size * 0.5
      ctx.font = `${size}px ${bold}`
      const wa = ctx.measureText(head).width
      const wb = ctx.measureText(tail).width
      numeral(ctx, number, l, H - b, huge, 'left', 'bottom')
      big(ctx, head, l, ya, size, 'left', frame, settled)
      big(ctx, tail, W - r, yb, size, 'right', frame + 3, settled)
      line(ctx, l + wa + 20, ya + size * 0.4, W - r - wb - 20, yb - size * 0.4)
      small(ctx, count, l, ya + size * 0.6, 'left', 'top', smallSize)
      note(ctx, text, W - r, yb - size * 0.62, noteSize, 'right', 'bottom')
    }
  }

  /** Each title showing at t, with the item it shows and that item's timing. */
  const showing = (t: number) =>
    o.titles.flatMap((card, ci) => {
      if (t < card.start || t >= card.end) return []
      const n = Math.floor((t - card.start) / o.swap)
      const j = n % card.items.length
      const isFirst = n === 0
      const isLast = card.start + (n + 1) * o.swap >= card.end - 1e-6
      const single = card.items.length === 1
      const start = single ? card.start : card.start + n * o.swap
      const end = single ? card.end : Math.min(card.end, start + o.swap)
      const i = (first[ci] ?? 0) + j
      const layout = layouts[i % layouts.length] ?? 'edge'
      return [{ card, j, i, isFirst, isLast, single, start, end, layout }]
    })

  /** Draws the title showing at t, if any, onto ctx (it does not clear it). */
  const draw = (ctx: Ctx, W: number, H: number, t: number, frame: number) => {
    for (const { card, j, i, isFirst, isLast, single, start, end, layout } of showing(t)) {
      const timing = {
        start,
        end,
        frame,
        rise: isFirst ? 0.3 : 0.14,
        fall: isLast ? 0.15 : 0.06,
        swap: !single && !isFirst,
      }
      const [titleText, noteText] = card.items[j] ?? ['', '']
      const title = decoded(titleText, t, { ...timing, seed: i * 3 })
      const text = decoded(noteText, t, { ...timing, start: start + 0.05, seed: i * 3 + 2 }).text
      const count = decoded(`${String(i + 1).padStart(2, '0')} / ${total}`, t, {
        ...timing,
        seed: i * 3 + 1,
      }).text
      one(
        ctx,
        W,
        H,
        layout,
        title.text,
        text,
        count,
        String(i + 1).padStart(2, '0'),
        (t - start) / (end - start),
        frame,
        title.settled,
      )
    }
  }

  /** The titles showing at t, as JSON for the film's inspect. */
  const inspect = (t: number): TitleState[] =>
    showing(t).map(({ card, j, i, start, end, layout }) => {
      const { items, ...own } = card as Title & { readonly [field: string]: Json }
      const [title, note] = items[j] ?? ['', '']
      return { ...own, item: j, index: i, title, note, layout, u: (t - start) / (end - start) }
    })

  return Object.assign(draw, { inspect })
}
