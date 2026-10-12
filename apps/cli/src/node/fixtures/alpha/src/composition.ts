import type { Open } from '@shaderera/core'

/**
 * Two layers of semi-transparent, non-saturated colour: straight (200, 120, 40) at alpha 128 over
 * the whole frame, and premultiplied (50, 50, 50) at alpha 128 over the right half. With
 * `unfinished`, the top layer says it is a progressive preview (`final: false`).
 */
const open: Open = ({ manifest, params }) => {
  const { width, height } = manifest
  const fill = (rgba: number[], from = 0) => {
    const bytes = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = from; x < width; x++) bytes.set(rgba, (y * width + x) * 4)
    return bytes
  }
  return {
    render: async () => [
      { color: fill([200, 120, 40, 128]), alpha: 'straight', name: 'base' },
      {
        color: fill([50, 50, 50, 128], width / 2),
        alpha: 'premultiplied',
        name: 'veil',
        ...(params.unfinished ? { final: false } : {}),
      },
    ],
  }
}
export default open
