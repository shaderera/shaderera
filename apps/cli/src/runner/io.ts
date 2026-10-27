// `io.image`, `io.video`, `io.cache` and `io.bake`, the same in both hosts: the Node host passes its IPC
// to the CLI process as `ask`, the runner worker its requests to the runner server.
import type { Baked, DecodedImage, Footage, Io, VideoColour } from '@shaderera/core'
import { sha256 } from '@shaderera/core'
import { decodeImage } from './image.ts'
import { timeVideo } from './render-time.ts'

/** What a host asks of the CLI's process (node/services.ts). */
export type Ask = {
  /**
   * A still decoded once for every host (ADR 0028, 1); the web player decodes it itself. Null for
   * a still too large for the cache: the host decodes it from its own `read`.
   */
  image(path: string, maxSize?: number): Promise<DecodedImage | null>
  cacheGet(hash: string): Promise<Uint8Array | null>
  cachePut(hash: string, bytes: Uint8Array): Promise<void>
  videoOpen(path: string): Promise<{
    width: number
    height: number
    fps: number
    frames: number
    colour: VideoColour
  }>
  videoFrame(path: string, index: number, format: 'rgba' | 'yuv420p'): Promise<Uint8Array>
  videoClose(path: string): Promise<void>
  bakeOpen(name: string): Promise<{ frames: number }>
  bakeFrame(name: string, index: number): Promise<Uint8Array>
}

/**
 * A still as the CLI's process opens it (services.ts, `image-open`): its decoded size, and the key
 * its bytes are asked by (`image-data`). `local`: too large for the cache (ADR 0028, 7), so the
 * CLI does not decode it, and each host decodes it itself.
 */
export type StillSize = { width: number; height: number; bits: 8 | 16; key: string; local?: true }

const text = new TextEncoder()

/**
 * A still as the CLI's process hands it over: its size (services.ts, `image-open`), then its
 * bytes. A view into a larger message (a small still over IPC) is copied, so `data.buffer` is the
 * still's alone.
 */
export const stillOf = (
  size: { width: number; height: number; bits: 8 | 16 },
  bytes: Uint8Array,
): DecodedImage => {
  const own =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
  const { width, height, bits } = size
  return { width, height, bits, data: bits === 16 ? new Uint16Array(own.buffer) : own }
}

/**
 * The ports over a host's `read` and its way to the CLI's process. The waits on `io.video` frames
 * inside render are timed (render-time.ts).
 */
export const extraIo = (
  read: (path: string) => Promise<Uint8Array>,
  ask: Ask,
): Required<Pick<Io, 'image' | 'video' | 'cache' | 'bake'>> => {
  const images = new Map<string, Promise<DecodedImage>>()
  return {
    image: (path, options) => {
      const key = `${options?.maxSize ?? 0} ${path}`
      let image = images.get(key)
      if (!image) {
        const maxSize = options?.maxSize
        image = ask
          .image(path, maxSize)
          .then(async (still) => still ?? decodeImage(await read(path), path, maxSize))
        images.set(key, image)
      }
      return image
    },
    video: async (path): Promise<Footage> => {
      const info = await ask.videoOpen(path)
      return {
        ...info,
        frame: (index, options) => {
          const format = options?.format ?? 'rgba'
          if (format !== 'rgba' && format !== 'yuv420p')
            throw new Error(
              `io.video(${path}): frame format is 'rgba' or 'yuv420p', not ${format}.`,
            )
          return timeVideo(() => ask.videoFrame(path, index, format))
        },
        close: () => ask.videoClose(path),
      }
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
