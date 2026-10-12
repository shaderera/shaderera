import type { Open } from '@shaderera/core'

/**
 * Fixture: a portrait Thai/Latin title card in Canvas2D only. Every element is a literal with an
 * `id`, so the stamp gives it a `source`; inspect spreads it and adds the measured box at t, and
 * pick hit-tests those boxes top-most first. Everything is a function of t and the params.
 */

const FONTS = [
  ['src/assets/fonts/NotoSans-Bold.ttf', 'Noto Sans Bold'],
  ['src/assets/fonts/NotoSans-Regular.ttf', 'Noto Sans'],
  ['src/assets/fonts/NotoSansThai-Regular.ttf', 'Noto Sans Thai'],
] as const

const headline = {
  id: 'headline',
  space: 'screen',
  text: 'Made in Code',
  x: 96,
  y: 520,
  size: 132,
  color: '#f4f1ea',
  at: 0.2,
}

const subtitle = {
  id: 'subtitle',
  space: 'screen',
  text: 'ทุกเฟรมเขียนด้วยโค้ด และตรวจสอบได้ทุกเฟรมโดยไม่ต้องเดา',
  x: 96,
  y: 640,
  size: 64,
  color: '#d8d4f0',
  at: 0.7,
  maxWidth: 860,
}

const rule = {
  id: 'rule',
  space: 'screen',
  text: '',
  x: 96,
  y: 860,
  size: 12,
  color: '#ff7a45',
  at: 1.2,
  width: 420,
}

const caption = {
  id: 'caption',
  space: 'screen',
  text: 'SHADERERA FIXTURE · 2D TITLE',
  x: 96,
  y: 940,
  size: 30,
  color: '#a3abb8',
  at: 1.6,
}

/** The entrance: 0.8 s at pace 1, a smoothstep, 40 px rise; then hold. */
const ENTER = 0.8
const RISE = 40

const ease = (x: number): number => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

const round = (n: number): number => Math.round(n * 1000) / 1000

const fontOf = (id: string, size: number) =>
  id === 'headline'
    ? `${size}px "Noto Sans Bold"`
    : id === 'subtitle'
      ? `${size}px "Noto Sans Thai", "Noto Sans"`
      : `${size}px "Noto Sans"`

type Ctx = OffscreenCanvasRenderingContext2D

/** Thai has no spaces between words: break at Intl.Segmenter word boundaries. */
const wrap = (ctx: Ctx, text: string, maxWidth: number): string[] => {
  const words = [...new Intl.Segmenter('th', { granularity: 'word' }).segment(text)].map(
    (s) => s.segment,
  )
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line + word
    if (line !== '' && ctx.measureText(next.trimEnd()).width > maxWidth) {
      lines.push(line.trimEnd())
      line = word.trimStart()
    } else line = next
  }
  if (line.trim() !== '') lines.push(line.trimEnd())
  return lines
}

const open: Open = async ({ manifest, params, io }) => {
  for (const [path, family] of FONTS) await io.font(path, family)
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  const ctx = canvas.getContext('2d') as Ctx
  const accent = String(params.accent ?? rule.color)
  const pace = Math.min(2, Math.max(0.5, Number(params.pace ?? 1)))

  // Layout does not depend on t: measure once (fonts are loaded), then only offset by the ease.
  const layout = (el: typeof headline | typeof subtitle | typeof caption) => {
    ctx.font = fontOf(el.id, el.size)
    const lines = 'maxWidth' in el ? wrap(ctx, el.text, el.maxWidth) : [el.text]
    const metrics = lines.map((l) => ctx.measureText(l))
    const ascent = Math.max(...metrics.map((m) => m.actualBoundingBoxAscent))
    const descent = Math.max(...metrics.map((m) => m.actualBoundingBoxDescent))
    const lineHeight = Math.round(el.size * 1.35)
    const w = Math.max(...metrics.map((m) => m.width))
    const h = ascent + descent + lineHeight * (lines.length - 1)
    return { lines, lineHeight, box: [el.x, el.y - ascent, w, h] as const }
  }
  const texts = [headline, subtitle, caption].map((el) => ({ el, ...layout(el) }))
  const ruleBox = [rule.x, rule.y, rule.width, rule.size] as const

  /** Bottom to top, in draw order. */
  const state = (t: number) => {
    const at = (start: number) => ease((t - start) / (ENTER / pace))
    const items = [
      ...texts.map(({ el, lines, lineHeight, box }) => ({
        el,
        lines,
        lineHeight,
        box,
        k: at(el.at),
      })),
      {
        el: { ...rule, color: accent },
        lines: [] as string[],
        lineHeight: 0,
        box: ruleBox,
        k: at(rule.at),
      },
    ]
    return items.map((i) => {
      const dy = (1 - i.k) * RISE
      return { ...i, dy, box: [i.box[0], i.box[1] + dy, i.box[2], i.box[3]].map(round) }
    })
  }

  return {
    async render(t) {
      const bg = ctx.createLinearGradient(0, 0, 0, height)
      bg.addColorStop(0, '#11131c')
      bg.addColorStop(1, '#2a1b3d')
      ctx.globalAlpha = 1
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, width, height)
      for (const s of state(t)) {
        if (s.k <= 0) continue
        ctx.globalAlpha = s.k
        ctx.fillStyle = s.el.color
        if (s.el.id === 'rule') {
          // The rule also grows from the left.
          ctx.fillRect(s.el.x, s.el.y + s.dy, rule.width * s.k, rule.size)
          continue
        }
        ctx.font = fontOf(s.el.id, s.el.size)
        s.lines.forEach((line, i) => {
          ctx.fillText(line, s.el.x, s.el.y + s.dy + i * s.lineHeight)
        })
      }
      ctx.globalAlpha = 1
      return { color: canvas, name: 'Title' }
    },
    async inspect(t) {
      return {
        params: { accent, pace },
        elements: state(t).map((s) => ({
          ...s.el,
          opacity: round(s.k),
          lines: s.lines,
          box: s.box,
        })),
      }
    },
    async pick(t, x, y) {
      const hit = state(t)
        .filter((s) => s.k > 0)
        .reverse()
        .find(
          ({ box: [bx, by, bw, bh] }) => x >= bx! && x <= bx! + bw! && y >= by! && y <= by! + bh!,
        )
      return hit ? { ['id']: hit.el.id } : null // computed key: not a stamped literal
    },
  }
}

export default open
