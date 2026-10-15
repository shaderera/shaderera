// `io.image`, `io.video`, `io.cache` and `io.bake`, the same in both hosts: the Node host passes its IPC
// to the CLI process as `ask`, the runner worker its requests to the runner server.
import type { Baked, DecodedImage, Footage, Io } from '@shaderera/core'
import { sha256 } from '@shaderera/core/host'
import { decodeImage } from './image.ts'

/** What a host asks of the CLI's process (node/services.ts). */
export type Ask = {
  cacheGet(hash: string): Promise<Uint8Array | null>
  cachePut(hash: string, bytes: Uint8Array): Promise<void>
  videoOpen(path: string): Promise<{ width: number; height: number; fps: number; frames: number }>
  videoFrame(path: string, index: number): Promise<Uint8Array>
  bakeOpen(name: string): Promise<{ frames: number }>
  bakeFrame(name: string, index: number): Promise<Uint8Array>
}

const text = new TextEncoder()

/** The ports over a host's `read` and its way to the CLI's process. */
export const extraIo = (
  read: (path: string) => Promise<Uint8Array>,
  ask: Ask,
): Required<Pick<Io, 'image' | 'video' | 'cache' | 'bake'>> => {
  const images = new Map<string, Promise<DecodedImage>>()
  return {
    image: (path) => {
      let image = images.get(path)
      if (!image) {
        image = read(path).then((bytes) => decodeImage(bytes, path))
        images.set(path, image)
      }
      return image
    },
    video: async (path): Promise<Footage> => {
      const info = await ask.videoOpen(path)
      return { ...info, frame: (index) => ask.videoFrame(path, index) }
    },
    cache: async (key, inputs, make) => {
      // The key, then each input's path and content hash: a changed file is another entry.
      const parts = [key]
      for (const path of inputs) parts.push(path, await sha256(await read(path)))
      const hash = await sha256(text.encode(parts.join('\0')))
      const kept = await ask.cacheGet(hash)
      if (kept) return kept
      const made = await make()
      if (!(made instanceof Uint8Array))
        throw new Error(`io.cache(${key}): make must return a Uint8Array.`)
      await ask.cachePut(hash, made)
      return made
    },
    bake: async (name): Promise<Baked> => {
      const { frames } = await ask.bakeOpen(name)
      const read = (index: number) => ask.bakeFrame(name, index)
      return {
        frames,
        read,
        image: async (index) => decodeImage(await read(index), `bake ${name} frame ${index}`),
      }
    },
  }
}
