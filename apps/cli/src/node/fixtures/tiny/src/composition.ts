import type { Open } from '@shaderera/core'

/** A background whose red follows t, and a half-transparent square on top. */
const open: Open = ({ io }) => {
  const back = io.canvas(64, 36)
  const top = io.canvas(64, 36)
  return {
    render: async (t) => {
      const b = back.getContext('2d') as OffscreenCanvasRenderingContext2D
      b.fillStyle = `rgb(${Math.round(t * 255)}, 40, 90)`
      b.fillRect(0, 0, 64, 36)
      const f = top.getContext('2d') as OffscreenCanvasRenderingContext2D
      f.clearRect(0, 0, 64, 36)
      f.fillStyle = 'rgba(255, 255, 255, 0.5)'
      f.fillRect(8 + t * 20, 8, 16, 16)
      return [
        { color: back, name: 'back' },
        { color: top, name: 'square' },
      ]
    },
    inspect: async (t) => ({
      back: { red: Math.round(t * 255), source: 'src/composition.ts:10:7' },
      square: { position: [8 + t * 20, 8], size: 16 },
    }),
  }
}

export default open
