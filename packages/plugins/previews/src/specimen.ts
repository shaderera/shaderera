// The type specimen the four font previews share. A font plugin installs font files and nothing
// else, so its preview shows only the typeface: its weights and styles as the plugin ships them,
// and its glyphs, set with plain fillText. The only motion is presentation: the sheet cuts between
// panels (each holds an equal share of the loop) and drifts slowly upward, at one steady speed,
// while it holds. The loop ends on the last panel and cuts to the first, like every other cut.
// Around it, the house frame: the family's name set in its own face, the index number, the HUD.

import type { Host } from '@shaderera/core'
import { createHouse, L, R } from './house.ts'
import { FONT } from './preview.ts'

type Ctx = OffscreenCanvasRenderingContext2D & { fontVariationSettings?: string }

/** A face as the canvas knows it: a registered family, and a wght for a variable font. */
export type Face = { family: string; wght?: number }

/** A panel of the sheet: `draw` sets it with its top at `top` (the drift included). */
export type Panel = { name: string; draw(top: number): void }

/** How far a panel drifts while it holds, in px: slow, and the same speed throughout. */
const DRIFT = 28
/** The sheet's window: under the title and above the HUD. */
const WINDOW = { top: 150, bottom: 846 }
const GREY = '#8a8a8a'
const WIDTH = R - L

export const createSpecimen = (
  host: Host,
  ctx: Ctx,
  o: {
    /** The family's name, set top left in the face itself. */
    title: string
    face: Face
    /** What the plugin installs, for the HUD. */
    files: string
  },
) => {
  const house = createHouse(host, ctx)
  const { width, height, duration } = host.manifest

  const set = (face: Face, size: number) => {
    ctx.font = `${size}px "${face.family}"`
    ctx.fontVariationSettings = face.wght === undefined ? 'normal' : `'wght' ${face.wght}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }
  const label = (text: string, x: number, y: number) => {
    ctx.font = `14px "${FONT.mono}"`
    ctx.fontVariationSettings = 'normal'
    ctx.textAlign = 'left'
    ctx.fillStyle = GREY
    ctx.fillText(text, x, y)
  }
  const rule = (y: number) => {
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.fillRect(L, Math.round(y), WIDTH, 1)
  }
  /** The largest size, up to `max`, at which `text` fits `room`. */
  const fit = (face: Face, text: string, max: number, room = WIDTH) => {
    set(face, 100)
    return Math.min(max, (100 * room) / Math.max(1, ctx.measureText(text).width))
  }
  /** `chars` broken into lines no wider than the sheet, at character boundaries. */
  const wrap = (face: Face, size: number, chars: string) => {
    set(face, size)
    const out: string[] = []
    let line = ''
    for (const ch of chars) {
      if (line && ctx.measureText(line + ch).width > WIDTH) {
        out.push(line.trimEnd())
        line = ch === ' ' ? '' : ch
      } else line += ch
    }
    if (line) out.push(line)
    return out
  }
  const text = (face: Face, size: number, s: string, x: number, y: number) => {
    set(face, size)
    ctx.fillStyle = '#fff'
    ctx.fillText(s, x, y)
  }

  return {
    /**
     * Rows of one sample, a row per weight: its label above it, the sample in each of the row's
     * faces side by side (roman, italic), every row at the one size that fits them all.
     */
    rows(
      name: string,
      rows: readonly { faces: readonly Face[]; label: string }[],
      sample: string,
      max = 130,
    ): Panel {
      const gap = 36
      return {
        name,
        draw(top) {
          const across = Math.max(...rows.map((r) => r.faces.length))
          const room = (WIDTH - gap * (across - 1)) / across
          const size = Math.min(
            ...rows.flatMap((r) => r.faces.map((f) => fit(f, sample, max, room))),
          )
          const step = Math.min(240, (WINDOW.bottom - WINDOW.top - 40) / rows.length)
          for (const [i, r] of rows.entries()) {
            const y = top + 24 + i * step
            rule(y)
            label(r.label, L, y + 22)
            for (const [k, f] of r.faces.entries())
              text(f, size, sample, L + k * (room + gap), y + 30 + size * 0.86)
          }
        },
      }
    },
    /** Lines set as large as the sheet allows, each with its label. */
    display(
      name: string,
      lines: readonly { face: Face; label: string; text: string }[],
      max = 300,
    ): Panel {
      return {
        name,
        draw(top) {
          let y = top + 24
          for (const l of lines) {
            const size = fit(l.face, l.text, max)
            rule(y)
            label(l.label, L, y + 22)
            text(l.face, size, l.text, L, y + 30 + size * 0.82)
            y += 30 + size * 1.08
          }
        },
      }
    },
    /** The glyphs a face has, group by group, each under its label (and in its own face, if given). */
    glyphs(
      name: string,
      face: Face,
      groups: readonly (readonly [string, string] | readonly [string, string, Face])[],
      size = 46,
    ): Panel {
      const lead = size * 1.3
      return {
        name,
        draw(top) {
          let y = top + 24
          for (const [title, chars, own] of groups) {
            rule(y)
            label(title, L, y + 22)
            y += 30
            for (const line of wrap(own ?? face, size, chars)) {
              y += lead
              text(own ?? face, size, line, L, y - size * 0.3)
            }
            y += 18
          }
        },
      }
    },
    /** One line at falling sizes, each labelled with its size; long lines run off the edge. */
    waterfall(name: string, face: Face, sample: string, sizes: readonly number[]): Panel {
      return {
        name,
        draw(top) {
          let y = top + 24
          for (const size of sizes) {
            rule(y)
            label(`${size} PX`, L, y + 20)
            y += 26 + size * 1.02
            text(face, size, sample, L, y - size * 0.2)
            y += 12
          }
        },
      }
    },
    /** The panel that holds at t, and how far into its hold (0 to 1). */
    at(t: number, panels: readonly Panel[]) {
      const hold = duration / panels.length
      const index = Math.min(panels.length - 1, Math.max(0, Math.floor(t / hold)))
      return { index, panel: panels[index] as Panel, held: (t - index * hold) / hold }
    },
    render(t: number, frame: number, panels: readonly Panel[]) {
      const { index, panel, held } = this.at(t, panels)
      const top = WINDOW.top + DRIFT * (1 - held)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, WINDOW.top, width, WINDOW.bottom - WINDOW.top)
      ctx.clip()
      panel.draw(top)
      ctx.restore()
      text(o.face, 60, o.title, L, 92)
      ctx.fontVariationSettings = 'normal'
      const n = (k: number) => String(k).padStart(2, '0')
      house.hud(t, frame, `${n(index + 1)} / ${n(panels.length)}   ${panel.name}`, o.files)
    },
  }
}

/** Glyph groups most Latin faces share. */
export const LATIN = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  figures: '0123456789',
  punctuation: `.,:;!?¡¿'"‘’“”«»‹›()[]{}/\\|-–—_&@#%*+=<>~^$€£¥¢§¶•…·°©®™`,
  accents: 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØŒÙÚÛÜÝŸ àáâãäåæçèéêëìíîïñòóôõöøœùúûüýÿß',
  cyrillic: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ абвгдежзийклмнопрстуфхцчшщэюя',
  greek: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ αβγδεζηθικλμνξοπρστυφχψω',
} as const
