import type { Manifest, Sink } from '@shaderera/core'
import { framesOfTimecode, timecodeOf } from '@shaderera/core/host'
import type { FrameInput } from '../deliver/chunks.ts'

/**
 * The time before the programme a manifest (or variant) declares, in whole frames before the
 * export's first frame: `frames`, `seconds` (exactly frames / fps) and how it is filled.
 */
export const prerollOf = (manifest: Manifest) => {
  const frames = manifest.preroll ? Math.round(manifest.preroll.seconds * manifest.fps) : 0
  return { frames, seconds: frames / manifest.fps, fill: manifest.preroll?.fill ?? 'black' }
}

/** One opaque black frame in the encoder's input format. */
export const blackFrame = (input: FrameInput, width: number, height: number): Uint8Array => {
  const pixels = width * height
  if (input === 'p010') {
    // An hdr10 render's: narrow range Y' 64 and Cb, Cr 512 in the top ten bits of each word.
    const words = new Uint16Array((pixels * 3) / 2).fill(512 << 6)
    words.fill(64 << 6, 0, pixels)
    return new Uint8Array(words.buffer)
  }
  // An hdr10 render's R'G'B' codes: PQ black is code 0.
  if (input === 'rgb10') return new Uint8Array(pixels * 4)
  if (input === 'yuv420p') {
    // Limited range: Y 16, Cb and Cr 128.
    const out = new Uint8Array((pixels * 3) / 2).fill(128)
    out.fill(16, 0, pixels)
    return out
  }
  if (input === 'rgba64') {
    const words = new Uint16Array(pixels * 4)
    for (let i = 3; i < words.length; i += 4) words[i] = 65535
    return new Uint8Array(words.buffer)
  }
  const out = new Uint8Array(pixels * 4)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  return out
}

/**
 * The timecode of the file's first frame: the programme's (`manifest.timecode`, or the export's
 * start counted from 00:00:00:00) less the preroll, wrapped at 24 hours as a timecode is.
 */
export const fileTimecode = (manifest: Manifest, from: number, prerollFrames: number): string => {
  const fps = manifest.fps
  const programme = manifest.timecode
    ? framesOfTimecode(manifest.timecode, fps)
    : Math.round(from * fps)
  const day = framesOfTimecode(`24:00:00${manifest.timecode?.includes(';') ? ';' : ':'}00`, fps)
  return timecodeOf((((programme - prerollFrames) % day) + day) % day, fps)
}

/** The frame times of a preroll before `from`: negative for an export from 0. */
export const prerollTimes = (o: { frames: number; from: number; fps: number }): number[] => {
  const first = Math.round(o.from * o.fps) - o.frames
  return Array.from({ length: o.frames }, (_, k) => (first + k) / o.fps)
}

/**
 * Writes the preroll's frames into a sink before the programme's: black, or the source's own at
 * the frame times before `from` (negative t for an export from 0). Aborts the sink on a failure.
 */
export const writePreroll = async (
  sink: Sink,
  o: {
    frames: number
    fill: 'black' | 'source'
    from: number
    fps: number
    black: () => Uint8Array
    render: (t: number) => Promise<Uint8Array | Uint8ClampedArray>
  },
) => {
  const times = prerollTimes(o)
  try {
    for (const t of times) await sink.write(o.fill === 'source' ? await o.render(t) : o.black())
  } catch (error) {
    await sink.abort?.()
    throw error
  }
}
