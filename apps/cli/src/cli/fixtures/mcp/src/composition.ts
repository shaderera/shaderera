import type { Matrices, Open } from '@shaderera/core'

const projection = [0.5625, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.001, -1, 0, 0, -0.1001, 0]

/** A camera that slides along x with t, and a box drawn where the camera puts it. */
const open: Open = ({ io }) => {
  const canvas = io.canvas(64, 36)
  let override: Matrices | null = null
  const get = async (t: number): Promise<Matrices> => ({
    view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t * 10, 0, -5, 1],
    projection,
  })
  const boxAt = async (t: number) => 20 + ((override ?? (await get(t))).view[12] as number)
  return {
    render: async (t) => {
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.clearRect(0, 0, 64, 36)
      ctx.fillStyle = 'rgb(255, 0, 0)'
      ctx.fillRect(await boxAt(t), 10, 8, 8)
      return { color: canvas, name: 'box' }
    },
    inspect: async (t) => ({
      camera: { id: 'camera', x: t * 10 },
      box: { id: 'box', x: await boxAt(t) },
    }),
    pick: async (t, x, y) => {
      const bx = await boxAt(t)
      return x >= bx && x < bx + 8 && y >= 10 && y < 18 ? { id: 'box' } : null
    },
    camera: {
      get,
      override: (m) => {
        override = m
      },
    },
  }
}

export default open
