import type { Open } from '@shaderera/core'

/** Two inspectable objects whose `source` comes from the stamp. */
const back = { id: 'back', red: 40 }

const dot = {
  id: 'dot',
  x: 4,
  size: 6,
}

const open: Open = ({ io }) => {
  const canvas = io.canvas(32, 18)
  return {
    render: async (t) => {
      const c = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      c.fillStyle = `rgb(${back.red}, 0, 0)`
      c.fillRect(0, 0, 32, 18)
      c.fillStyle = 'white'
      c.fillRect(dot.x + t * 10, 6, dot.size, dot.size)
      return { color: canvas, name: 'all' }
    },
    inspect: async (t) => ({ back, dot: { ...dot, x: dot.x + t * 10 } }),
  }
}

export default open
