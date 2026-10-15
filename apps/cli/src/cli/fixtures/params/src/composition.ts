import type { Open } from '@shaderera/core'

/** A frame filled with the `grey` param, which inspect reports with t. */
const open: Open = ({ io, params }) => {
  const canvas = io.canvas(16, 16)
  const grey = Number(params.grey)
  return {
    render: async () => {
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = `rgb(${grey}, ${grey}, ${grey})`
      ctx.fillRect(0, 0, 16, 16)
      return { color: canvas }
    },
    inspect: async (t) => ({ t, grey }),
  }
}

export default open
