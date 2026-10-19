import type { Open } from '@shaderera/core'

/** A grey frame, a tone made in code, and the `clip` param's file played with its sound at 0.2 s. */
const open: Open = ({ io, params }) => {
  const canvas = io.canvas(16, 16)
  const tone = new Float32Array(48000).map(
    (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 48000),
  )
  const clip = String(params.clip ?? '')
  return {
    render: async () => {
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = 'rgb(128, 128, 128)'
      ctx.fillRect(0, 0, 16, 16)
      return { color: canvas }
    },
    audio: async () => [
      { pcm: { sampleRate: 48000, channels: [tone] }, at: 0 },
      ...(clip ? [{ src: clip, at: 0.2 }] : []),
    ],
  }
}

export default open
