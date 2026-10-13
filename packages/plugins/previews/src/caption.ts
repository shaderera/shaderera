// The caption block, the same on every preview: a black band along the bottom with the item's
// name in Plex Mono (its category in grey), what it does in one plain sentence in Plex Sans, and
// a few words of live state at the right.

import type { Host } from '@shaderera/core'
import { FONT } from './preview.ts'

export const CAPTION = {
  /** The band's top edge; the item's picture has the frame above it. */
  top: 904,
  margin: 48,
  name: { size: 36, baseline: 62 },
  line: { size: 31, first: 112, step: 41 },
  status: { size: 22 },
}

type Ctx = OffscreenCanvasRenderingContext2D

const wrap = (ctx: Ctx, text: string, width: number) => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > width) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export const createCaption = (host: Host, item: string, sentence: string) => {
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const c = CAPTION
  const room = width - 2 * c.margin
  ctx.font = `${c.line.size}px "${FONT.sans}"`
  const lines = wrap(ctx, sentence, room)
  if (lines.length > 2)
    throw new Error(`The caption for ${item} needs ${lines.length} lines; keep it to 2`)
  const dash = item.indexOf('-') + 1
  const category = item.slice(0, dash)

  const runs = (status: string) => {
    ctx.font = `${c.name.size}px "${FONT.monoBold}"`
    const nameWidth = ctx.measureText(item).width
    ctx.font = `${c.status.size}px "${FONT.mono}"`
    const statusWidth = ctx.measureText(status).width
    return [
      {
        id: 'caption-name',
        text: item,
        font: `${c.name.size}px "${FONT.monoBold}"`,
        box: [c.margin, c.top + c.name.baseline - c.name.size, nameWidth, c.name.size * 1.25],
      },
      ...lines.map((text, i) => {
        ctx.font = `${c.line.size}px "${FONT.sans}"`
        return {
          id: `caption-line-${i}`,
          text,
          font: `${c.line.size}px "${FONT.sans}"`,
          box: [
            c.margin,
            c.top + c.line.first + i * c.line.step - c.line.size,
            ctx.measureText(text).width,
            c.line.size * 1.3,
          ],
        }
      }),
      ...(status
        ? [
            {
              id: 'caption-status',
              text: status,
              font: `${c.status.size}px "${FONT.mono}"`,
              box: [
                width - c.margin - statusWidth,
                c.top + c.name.baseline - c.status.size,
                statusWidth,
                c.status.size * 1.3,
              ],
            },
          ]
        : []),
    ]
  }

  return {
    runs,
    draw(status: string) {
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, c.top, width, height - c.top)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, c.top, width, 2)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      const y = c.top + c.name.baseline
      ctx.font = `${c.name.size}px "${FONT.monoBold}"`
      ctx.fillStyle = '#7d7d7d'
      ctx.fillText(category, c.margin, y)
      ctx.fillStyle = '#fff'
      ctx.fillText(item.slice(dash), c.margin + ctx.measureText(category).width, y)
      ctx.font = `${c.line.size}px "${FONT.sans}"`
      ctx.fillStyle = '#e8e8e8'
      lines.forEach((line, i) => {
        ctx.fillText(line, c.margin, c.top + c.line.first + i * c.line.step)
      })
      if (status) {
        ctx.font = `${c.status.size}px "${FONT.mono}"`
        ctx.textAlign = 'right'
        ctx.fillStyle = '#7d7d7d'
        ctx.fillText(status, width - c.margin, y)
      }
      return canvas
    },
  }
}
