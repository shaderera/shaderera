import type { Open } from '@shaderera/core'

/** Returns the DOM as the frame, and reports the DOM bitmap's size and its first row's red. */
const open: Open = () => {
  let seen: { width: number; height: number; row: number[] } | null = null
  return {
    render: async (_t, o) => {
      if (!o.dom) throw new Error('no DOM')
      const c = new OffscreenCanvas(o.dom.width, o.dom.height).getContext('2d')
      c?.drawImage(o.dom, 0, 0)
      const row = c?.getImageData(0, 0, o.dom.width, 1).data ?? new Uint8ClampedArray()
      seen = {
        width: o.dom.width,
        height: o.dom.height,
        row: [...row].filter((_, i) => i % 4 === 0),
      }
      return { color: o.dom, name: 'DOM' }
    },
    inspect: async () => seen,
  }
}
export default open
