// `io.image`, `io.video`, `io.cache` and `io.bake`, the same in both hosts: the Node host passes its IPC
// to the CLI process as `ask`, the runner worker its requests to the runner server.
import type { Baked, DecodedImage, Footage, FootageSpace, Io, VideoColour } from '@shaderera/core'
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
  /** `declared`: the film said what the file is (`check` notes footage it did not, #575). */
  videoOpen(
    path: string,
    declared?: boolean,
  ): Promise<{
    width: number
    height: number
    fps: number
    frames: number
    bits: 8 | 10 | 12 | 16
    colour: VideoColour
  }>
  /** The frame's bytes; `yuv420p10`'s 16-bit samples little-endian, as bytes. */
  videoFrame(
    path: string,
    index: number,
    format: 'rgba' | 'yuv420p' | 'yuv420p10',
  ): Promise<Uint8Array>
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

/** The names `io.video` knows (`FootageSpace`), so a film's typo throws rather than passes. */
const TRANSFERS: { [k in NonNullable<FootageSpace['transfer']>]: true } = {
  bt709: true,
  srgb: true,
  pq: true,
  hlg: true,
  slog3: true,
  logc3: true,
  logc4: true,
  vlog: true,
  clog3: true,
}
const GAMUTS: { [k in NonNullable<FootageSpace['gamut']>]: true } = {
  rec709: true,
  rec2020: true,
  p3d65: true,
  sgamut3: true,
  sgamut3cine: true,
  awg3: true,
  awg4: true,
  vgamut: true,
  cinemagamut: true,
}

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
    video: async (path, space): Promise<Footage> => {
      for (const [key, known] of [
        ['transfer', TRANSFERS],
        ['gamut', GAMUTS],
      ] as const) {
        const value = space?.[key]
        if (value !== undefined && !Object.hasOwn(known, value))
          throw new Error(
            `io.video(${path}): ${key} is one of ${Object.keys(known)
              .map((k) => `'${k}'`)
              .join(', ')}, not '${value}'.`,
          )
      }
      // A gamut alone picks no curve: only a transfer says what the codes are (check, #575).
      const declared = space?.transfer !== undefined
      const info = await ask.videoOpen(path, declared)
      const frame = async (index: number, options?: { format?: string }) => {
        const format = options?.format ?? 'rgba'
        if (format !== 'rgba' && format !== 'yuv420p' && format !== 'yuv420p10')
          throw new Error(
            `io.video(${path}): frame format is 'rgba', 'yuv420p' or 'yuv420p10', not ${format}.`,
          )
        const bytes = await timeVideo(() => ask.videoFrame(path, index, format), { path, index })
        if (format !== 'yuv420p10') return bytes
        // 16-bit samples (ADR 0031, 1): a view needs an even offset, so bytes at an odd one (in
        // a larger message) are copied.
        const own = bytes.byteOffset % 2 ? bytes.slice() : bytes
        return new Uint16Array(own.buffer, own.byteOffset, own.byteLength / 2)
      }
      return {
        ...info,
        ...((space?.transfer ?? space?.gamut) ? { space } : {}),
        frame: frame as Footage['frame'],
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
