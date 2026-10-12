import type { Open } from '@shaderera/core'

/**
 * Feedback fed by the DOM and the camera: each frame halves the state and adds the DOM bar's
 * width (times 3 under a camera override). The frame shows the state; inspect reports it.
 */
const open: Open = ({ manifest, io }) => {
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  let state = 0
  let camera = false
  return {
    render: async (t, o) => {
      if (!o.dom) throw new Error(`no DOM at frame ${o.frame}`)
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(o.dom, 0, 0)
      const row = ctx.getImageData(0, 0, width, 1).data
      let bar = 0
      for (let i = 3; i < row.length; i += 4) if ((row[i] as number) > 127) bar++
      state = Math.floor(state / 2) + bar * (camera ? 3 : 1)
      const bytes = new Uint8Array(width * height * 4)
      for (let i = 0; i < bytes.length; i += 4) bytes.set([state & 255, state >> 8, 0, 255], i)
      return { color: bytes, alpha: 'opaque' }
    },
    inspect: async () => ({ state }),
    camera: {
      get: async () => ({
        view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      }),
      override: (m) => {
        camera = m !== null
      },
    },
  }
}
export default open
