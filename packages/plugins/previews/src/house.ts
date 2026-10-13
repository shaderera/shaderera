// The house style every preview shares, the one the opening film set: a black ground; big
// uppercase words in Plex Mono SemiBold in the top-left and bottom-right corners that decode or
// scramble in when they change; a small note in Instrument Serif Italic (from
// font-instrument-serif, registered by the composition); tiny mono labels in the corners; a huge,
// faint, outlined index number behind the picture; red for markers only. All of it is drawn into
// a Canvas2D overlay above the picture and under the caption (which starts at y 904).
//
// The index number is the plugin's place among the plugins that have a preview, in alphabetical
// order. scripts/render.ts writes those plugins into shaderera.json (params.item's enum), so a new
// plugin needs no number.

import type { Host } from '@shaderera/core'
import { CAPTION } from './caption.ts'
import { FONT } from './preview.ts'
import { decoded, glitched, hollow, timecode } from './type/kinetic.ts'

export const RED = '#ff3b1f'
export const SERIF = FONT.serif
export const L = 48
export const R = 1032
/** The bottom of the picture: the caption band starts here. */
export const PICTURE = CAPTION.top
/** The picture above the caption band, and its margins. */
export const AREA = { left: L, right: R, top: 0, bottom: PICTURE }

/** A word, or a note, that holds from `from` to `to` seconds. */
export type Word = { from: number; to: number; text: string }

type Ctx = OffscreenCanvasRenderingContext2D

/** The plugin the host opened, its index number (from 1) and how many plugins have a preview. */
export const placeOf = (host: Host) => {
  const item = String(host.params.item ?? '')
  const schema = host.manifest.params as { properties?: { item?: { enum?: unknown } } } | undefined
  const list = schema?.properties?.item?.enum
  const all = (Array.isArray(list) ? list.map(String) : []).sort()
  return { item, index: all.indexOf(item) + 1, total: all.length }
}

/** A deterministic 0–1 hash. */
export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

const GLYPHS = '#$%&*+<>?@/\\=;:0123456789ABCDEFHKXZ'

/** `text` resolving out of noise as p goes 0 → 1 (and back into noise as it falls). */
export const scramble = (text: string, p: number, frame: number, seed = 0) => {
  if (p >= 1) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    const settle = 0.15 + 0.75 * hash(i * 13.7 + seed)
    out +=
      ch === ' ' || p >= settle
        ? ch
        : (GLYPHS[Math.floor(hash(frame * 7.3 + i * 31 + seed) * GLYPHS.length)] ?? '#')
  }
  return out
}

/** Frame and time, as the film's HUD writes them. */
export const frameLabel = (frame: number, frames = 180) =>
  `FRAME ${String(frame).padStart(4, '0')} / ${String(frames).padStart(4, '0')}`

/** The film's pastel iridescence at phase `h` (0 to 1): peach, lilac, mint, sky. */
export const iridescent = (h: number): [number, number, number] => {
  const a = 6.2831853 * h
  return [0.78 + 0.22 * Math.cos(a), 0.72 + 0.2 * Math.cos(a - 2.1), 0.8 + 0.2 * Math.cos(a - 4.2)]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The house style for the plugin the host opened, drawn into `ctx`. */
export const createHouse = (host: Host, ctx: Ctx) => {
  const { item, index, total } = placeOf(host)
  const { duration } = host.manifest
  const mono = `"${FONT.mono}"`
  const bold = `"${FONT.monoBold}"`
  const at = (words: readonly Word[], t: number) =>
    words.find((w) => t >= w.from && t < w.to) ?? words[words.length - 1]
  /** A word that spans the loop's seam does not scramble there. */
  const span = (w: Word) => ({
    from: w.from <= 0 ? -1 : w.from,
    to: w.to >= duration ? duration + 1 : w.to,
  })

  /** A big word, decoding in out of noise when it starts and scrambling out before it ends. */
  const word = (
    words: readonly Word[],
    t: number,
    frame: number,
    corner: 'top' | 'bottom',
    size: number,
  ) => {
    const w = at(words, t)
    if (!w) return
    const { from, to } = span(w)
    const d = decoded(w.text, t, {
      from,
      to,
      frame,
      seed: w.text.length * 7 + (corner === 'top' ? 0 : 3),
      rise: 0.22,
      fall: 0.1,
      swap: true,
    })
    const since = t - from
    ctx.fillStyle = '#fff'
    glitched(ctx, d.text, corner === 'top' ? L - 4 : R + 4, corner === 'top' ? 62 : 852, {
      font: bold,
      size,
      frame,
      align: corner === 'top' ? 'left' : 'right',
      amount: Math.max(0, Math.exp(-since / 0.12) * 0.9, d.settled ? 0 : 0.35),
      bands: 9,
    })
    ctx.textBaseline = 'alphabetic'
  }

  const labels = () => {
    ctx.font = `14px ${mono}`
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#9a9a9a'
    ctx.textAlign = 'right'
    ctx.fillText('SHADERERA / PLUGINS', R, 30)
    ctx.fillText(item.toUpperCase(), R, 48)
  }

  return {
    item,
    /** The plugin's place: its index number (from 1) and how many plugins have a preview. */
    place: { index, total },
    /** The huge faint number behind everything, bottom left. */
    index() {
      hollow(ctx, pad(index), 20, 880, {
        font: bold,
        size: 430,
        color: 'rgba(255,255,255,0.15)',
        width: 2,
      })
    },
    /** The top-left and bottom-right words: each holds from its `from` to its `to`. */
    words(top: readonly Word[], bottom: readonly Word[], t: number, frame: number, size = 76) {
      word(top, t, frame, 'top', size)
      word(bottom, t, frame, 'bottom', size)
    },
    /**
     * A big word in Plex Mono SemiBold, uppercase, at a corner (`tl` from its top-left, `br` from
     * its bottom-right baseline): it scrambles in over 0.3 s after `since` 0, glitches into bands
     * while it does, and scrambles out in the last 0.2 s before `until` 0. Returns its size.
     */
    bigWord(o: {
      text: string
      corner: 'tl' | 'br'
      /** Where the word sits; by default the house's corners (its baseline at 62 or 852). */
      x?: number
      y?: number
      size?: number
      maxWidth?: number
      since: number
      until?: number
      frame: number
      color?: string
    }) {
      const text = o.text.toUpperCase()
      ctx.font = `100px ${bold}`
      const fit = (100 * (o.maxWidth ?? 940)) / Math.max(1, ctx.measureText(text).width)
      const size = Math.min(o.size ?? 76, fit)
      const x = o.x ?? (o.corner === 'tl' ? L - 4 : R + 4)
      const p = Math.min(Math.min(1, o.since / 0.3), Math.min(1, (o.until ?? 9) / 0.2))
      const shown = scramble(text, p, o.frame, text.length)
      ctx.font = `${size}px ${bold}`
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = o.corner === 'tl' ? 'left' : 'right'
      const y =
        o.y === undefined
          ? o.corner === 'tl'
            ? 62
            : 852
          : o.corner === 'tl'
            ? o.y + size * 0.74
            : o.y
      ctx.fillStyle = o.color ?? '#fff'
      if (p >= 1) {
        ctx.fillText(shown, x, y)
        return size
      }
      // Glitch bands: horizontal slices thrown sideways while the word resolves.
      const bands = 5
      const top = y - size * 0.8
      const h = size * 0.95
      for (let b = 0; b < bands; b++) {
        const r = hash(o.frame * 3.1 + b * 17)
        const dx = r < 0.55 ? (hash(o.frame + b * 5.3) - 0.5) * size * 0.9 * (1 - p) : 0
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, top + (b * h) / bands, 1080, h / bands + 0.5)
        ctx.clip()
        ctx.fillText(shown, x + dx, y)
        ctx.restore()
      }
      return size
    },
    /** A note in italic serif, above the bottom word by default. */
    note(
      text: string,
      x = R,
      y = 790,
      align: CanvasTextAlign = 'right',
      size = 28,
      color = '#d8d8d8',
    ) {
      ctx.font = `${size}px "${SERIF}"`
      ctx.textAlign = align
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = color
      ctx.fillText(text, x, y)
    },
    /** The note that holds at t, decoding in with its words. */
    notes(
      notes: readonly Word[],
      t: number,
      frame: number,
      x = R,
      y = 790,
      align: CanvasTextAlign = 'right',
      size = 28,
    ) {
      const w = at(notes, t)
      if (!w) return
      const d = decoded(w.text, t, { ...span(w), frame, seed: 91, rise: 0.3, fall: 0.08 })
      ctx.font = `${size}px "${SERIF}"`
      ctx.textAlign = align
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#d8d8d8'
      ctx.fillText(d.text, x, y)
    },
    /** Only the top-right labels, for a picture with its own header: the house and the plugin. */
    labels,
    /**
     * The tiny labels: the index under the top word, the house and the plugin top right (and
     * `extra` under them), t and the frame bottom left over a measurement. Where a picture's own
     * type takes the other corners, `top-right` puts them all top right.
     */
    hud(
      t: number,
      frame: number,
      measure: string,
      extra = '',
      corners: 'all' | 'top-right' = 'all',
    ) {
      labels()
      const clock = `T ${timecode(t)}   F ${String(frame).padStart(3, '0')}`
      if (corners === 'top-right') ctx.fillText(`${clock}   ${measure}`, R, 84)
      else {
        ctx.textAlign = 'left'
        ctx.fillText(`${pad(index)} / ${pad(total)}`, L, 128)
        ctx.fillText(clock, L, 862)
        ctx.fillText(measure, L, 882)
        ctx.textAlign = 'right'
      }
      if (extra) ctx.fillText(extra, R, 66)
    },
    /** A dark wash at the top and bottom, so the type reads over bright imagery. */
    wash(width = host.manifest.width) {
      const top = ctx.createLinearGradient(0, 0, 0, 170)
      top.addColorStop(0, 'rgba(0,0,0,0.75)')
      top.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = top
      ctx.fillRect(0, 0, width, 170)
      const bottom = ctx.createLinearGradient(0, 700, 0, PICTURE)
      bottom.addColorStop(0, 'rgba(0,0,0,0)')
      bottom.addColorStop(1, 'rgba(0,0,0,0.8)')
      ctx.fillStyle = bottom
      ctx.fillRect(0, 700, width, PICTURE - 700)
    },
  }
}

export type House = ReturnType<typeof createHouse>
