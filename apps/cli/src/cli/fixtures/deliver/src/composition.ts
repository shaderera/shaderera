import type { Open } from '@shaderera/core'

/** A half-transparent box over a transparent background, a text run and a tone at 0.2 s. */
const open: Open = ({ io, manifest, params }) => {
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  const text = params.locale === 'th' ? 'สวัสดี' : 'Hello'
  return {
    render: async (t) => {
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = 'rgba(0, 128, 255, 0.5)'
      ctx.fillRect(4 + t * 10, height / 2 - 4, 8, 8)
      return { color: canvas, name: 'box' }
    },
    inspect: async () => ({ locale: params.locale ?? 'en', text: { id: 'title', text } }),
    audio: async () => [{ src: 'audio/tone.wav', at: 0.2 }],
  }
}

export default open
