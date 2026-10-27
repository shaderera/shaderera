import type { Open } from '@shaderera/core'

/**
 * A film for the web player's tests: frame t is the clip's frame floor(t × fps), as io.video gives
 * it (assets/clip.mp4, made by the test: ffmpeg's testsrc2, 320×180, 30 fps, 1 s). inspect says
 * which frame that is, its yuv420p planes (base64) and colour, and what io.bake and io.cache
 * answered.
 */
const open: Open = async ({ io }) => {
  if (!io.video || !io.bake || !io.cache)
    throw new Error('This film needs io.video, io.bake and io.cache.')
  const clip = await io.video('assets/clip.mp4')
  const level = await io.bake('level')
  let made = 0
  const make = async () => {
    made++
    return new Uint8Array([7, 8, 9])
  }
  const cached = [
    ...(await io.cache('fixture', [], make)),
    ...(await io.cache('fixture', [], make)),
  ]
  const base64 = (b: Uint8Array) => {
    let s = ''
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
    return btoa(s)
  }
  const at = (t: number) => Math.min(clip.frames - 1, Math.floor(t * clip.fps + 1e-6))
  return {
    render: async (t) => ({ color: await clip.frame(at(t)), alpha: 'opaque', name: 'clip' }),
    inspect: async (t) => ({
      clip: { width: clip.width, height: clip.height, fps: clip.fps, frames: clip.frames },
      frame: at(t),
      colour: clip.colour,
      planes: base64(await clip.frame(at(t), { format: 'yuv420p' })),
      level: {
        frames: level.frames,
        first: (await level.read(0))[0] ?? null,
        last: (await level.read(level.frames - 1))[0] ?? null,
      },
      cache: { bytes: cached, made },
    }),
  }
}

export default open
