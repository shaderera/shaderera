import { videoReader } from '../node/services.ts'

/**
 * A rendered file, read as `io.video` reads a clip: its size and length, and the frame shown at
 * each t (the frame whose time is the last at or before t).
 */
export const openFile = (file: string) => {
  const reader = videoReader(file)
  const { width, height, fps, frames, bits, colour } = reader.info
  return {
    width,
    height,
    fps,
    frames,
    bits,
    colour,
    duration: frames / fps,
    frame: (t: number) => reader.frame(Math.min(frames - 1, Math.floor(t * fps + 1e-6))),
    /** Frame i, 0 to frames - 1. */
    index: (i: number) => reader.frame(i),
    close: () => reader.dispose(),
  }
}
