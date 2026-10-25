// The decoder behind `io.video` (services.ts), run in a thread of its own (video-worker.ts).
import { spawn } from 'node:child_process'
import type { VideoInfo } from './services.ts'

/**
 * Decodes one file's frames in order with ffmpeg. The last `keep()` frames up to the latest asked
 * are kept, so a frame asked a little out of order is given again without decoding; one before
 * them restarts it, as does one far ahead. The decoder runs up to `ahead()` frames past the latest
 * asked (`keep()` by default), so the next frames are decoded while the hosts render, not when
 * they ask.
 */
export const videoDecoder = (
  file: string,
  info: VideoInfo,
  keep: () => number = () => 1,
  ahead: () => number = keep,
) => {
  const size = info.width * info.height * 4
  let proc: ReturnType<typeof spawn> | undefined
  // The index of the frame being filled, its bytes and how many came.
  let next = 0
  let filling: Uint8Array | undefined
  let filled = 0
  // Decoded frames, in order and without gaps: the kept ones and the ones decoded ahead.
  let frames: { index: number; bytes: Uint8Array }[] = []
  // The latest frame asked since the decoder started.
  let asked = 0
  let waiting: (() => void) | undefined
  let ended = false
  // Why the decoder could not start (no ffmpeg): every read of it fails with it.
  let failed: Error | undefined
  const trim = () => {
    const oldest = asked - Math.max(1, keep()) + 1
    if ((frames[0]?.index ?? oldest) < oldest) frames = frames.filter((f) => f.index >= oldest)
  }
  // Decoded far enough past the latest asked: ffmpeg waits until a host catches up.
  const full = () => next - 1 - asked >= Math.max(1, ahead())
  const start = (from: number) => {
    proc?.kill()
    // Software decode, every frame from `from` on, converted by the file's own colour tags.
    proc = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-vf',
        `select=gte(n\\,${from}),scale=in_color_matrix=auto:in_range=auto:out_range=full,format=rgba`,
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    next = from
    asked = from
    frames = []
    filling = undefined
    filled = 0
    ended = false
    failed = undefined
    // Events of a decoder that was replaced (a jump back) are ignored.
    const mine = proc
    mine.on('error', (error) => {
      if (proc !== mine) return
      failed = new Error(`ffmpeg could not decode ${file}: ${error.message}`)
      ended = true
      waiting?.()
    })
    mine.stdout?.on('data', (d: Buffer) => {
      if (proc !== mine) return
      // Copied once, into the frame's own buffer, as the bytes come.
      for (let at = 0; at < d.length; ) {
        filling ??= new Uint8Array(Buffer.allocUnsafeSlow(size).buffer, 0, size)
        const n = Math.min(size - filled, d.length - at)
        filling.set(d.subarray(at, at + n), filled)
        filled += n
        at += n
        if (filled === size) {
          frames.push({ index: next++, bytes: filling })
          filling = undefined
          filled = 0
        }
      }
      trim()
      if (full()) mine.stdout?.pause()
      waiting?.()
    })
    mine.stdout?.on('end', () => {
      if (proc !== mine) return
      ended = true
      waiting?.()
    })
  }
  const read = async (index: number): Promise<Uint8Array> => {
    if (!Number.isInteger(index) || index < 0 || index >= info.frames)
      throw new Error(`${file} has frames 0 to ${info.frames - 1}, not ${index}.`)
    // A jump far ahead restarts the decoder: a new one skips the frames before `index` inside
    // ffmpeg, where this one would convert and pipe every one of them (decoding is about a third of
    // that work, so the restart is cheaper past half of `next`).
    if (proc && index - next > Math.max(30, next / 2)) start(index)
    // Raised and trimmed first, so the frames looked in are the ones kept from now on (a `keep()`
    // that shrank since, a host gone, drops some).
    asked = Math.max(asked, index)
    trim()
    for (;;) {
      if (!proc) start(index)
      const found = frames.find((f) => f.index === index)
      if (found) {
        if (!full()) proc?.stdout?.resume()
        return found.bytes
      }
      // Behind what is kept (a jump back) or behind where it decodes: only a new decoder reaches
      // it, never this one reading on.
      if (index < (frames[0]?.index ?? next)) {
        start(index)
        continue
      }
      if (failed) throw failed
      if (ended) throw new Error(`${file} ended before frame ${index}.`)
      proc?.stdout?.resume()
      await new Promise<void>((done) => {
        waiting = done
      })
      waiting = undefined
    }
  }
  // Ends the decoder and drops what it decoded; the next read starts another.
  const stop = async () => {
    const mine = proc
    proc = undefined
    frames = []
    filling = undefined
    filled = 0
    if (!mine || mine.exitCode !== null || mine.signalCode !== null) return
    const exited = new Promise((done) => mine.once('exit', done))
    mine.kill()
    await exited
  }
  // One request at a time: they share the decoder.
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run)
    queue = result.catch(() => {})
    return result
  }
  return {
    frame: (index: number) => inTurn(() => read(index)),
    close: () => inTurn(stop),
    /** The decoder's process id, while one runs. */
    get pid() {
      return proc?.pid
    },
  }
}
