import type { Open } from '@shaderera/core'

/**
 * A box that holds, moves right with an ease in and out from 0.5 s to 1.2 s, then holds: a motion
 * window to find. `delay` (seconds) starts the move later, for a reference made from this film.
 * It draws in fractions of the frame, so the `large` variant is the same picture at twice the size.
 */
const open: Open = ({ io, manifest, params }) => {
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  const delay = Number(params.delay)
  return {
    render: async (t) => {
      const p = Math.min(1, Math.max(0, (t - 0.5 - delay) / 0.7))
      const eased = p * p * (3 - 2 * p)
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = 'rgb(20, 30, 60)'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = 'rgb(255, 200, 0)'
      const side = height / 3
      ctx.fillRect(width * (0.1 + 0.6 * eased), height / 3, side, side)
      return { color: canvas }
    },
  }
}

export default open
