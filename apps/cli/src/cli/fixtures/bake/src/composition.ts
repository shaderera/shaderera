import type { Json, Open } from '@shaderera/core'

/** A grey from the baked frame for t; inspect tells whether `peek` (a path) can be io.read. */
const open: Open = async ({ io, params }) => {
  const glow = await (io.bake as NonNullable<typeof io.bake>)('glow')
  const canvas = io.canvas(8, 8)
  return {
    render: async (t) => {
      const [v] = await glow.read(Math.round(t * 10))
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = `rgb(${v}, ${v}, ${v})`
      ctx.fillRect(0, 0, 8, 8)
      return { color: canvas }
    },
    inspect: async () => {
      const out: { [key: string]: Json } = { frames: glow.frames }
      if (params.peek)
        out.peek = await io.read(String(params.peek)).then(
          () => 'read',
          (e: Error) => e.message,
        )
      return out
    },
  }
}

export default open
