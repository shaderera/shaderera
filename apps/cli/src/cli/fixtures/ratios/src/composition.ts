import type { Open } from '@shaderera/core'

type Box = [number, number, number, number]

/**
 * One film for two outputs: a word and a square that grows. It lays out by `host.variant`, not
 * by guessing from the size: `9:16` stacks the word over the square, anything else (`16:9`, the
 * manifest's own output) puts them side by side.
 */
const open: Open = ({ io, manifest, variant }) => {
  const { width, height } = manifest
  const stacked = variant === '9:16'
  const canvas = io.canvas(width, height)
  const size = Math.round(Math.min(width, height) * 0.1)
  const font = `${size}px sans-serif`
  const word = 'One film'
  const at = (t: number) => {
    const grow = Math.min(1, t)
    const side = Math.round(Math.min(width, height) * (0.2 + 0.2 * grow))
    const block: Box = stacked
      ? [Math.round((width - side) / 2), Math.round(height * 0.55), side, side]
      : [Math.round(width * 0.6), Math.round((height - side) / 2), side, side]
    const title: Box = stacked
      ? [Math.round(width * 0.1), Math.round(height * 0.25), Math.round(width * 0.8), size]
      : [Math.round(width * 0.1), Math.round((height - size) / 2), Math.round(width * 0.4), size]
    return { block, title }
  }
  return {
    render: async (t) => {
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      const { block, title } = at(t)
      ctx.fillStyle = 'rgb(20, 24, 32)'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = 'rgb(230, 120, 40)'
      ctx.fillRect(...block)
      ctx.fillStyle = 'rgb(240, 240, 240)'
      ctx.font = font
      ctx.textBaseline = 'top'
      ctx.fillText(word, title[0], title[1], title[2])
      return { color: canvas }
    },
    inspect: async (t) => {
      const { block, title } = at(t)
      return {
        variant: variant ?? null,
        layout: stacked ? 'stacked' : 'side by side',
        title: { id: 'title', text: word, box: title, font },
        block: { id: 'block', bbox: block },
        shots: [
          { id: 'grow', start: 0, end: 1 },
          { id: 'hold', start: 1, end: 2 },
        ],
      }
    },
  }
}

export default open
