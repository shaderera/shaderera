// The thread that feeds an encoding ffmpeg (ffmpegSink): it starts ffmpeg, mattes each frame and
// writes it to ffmpeg's stdin, so the CLI's own thread, which takes every host's frames, does not
// also copy each one into the pipe (#434). It says when a frame was taken (`written`), passes on
// what ffmpeg says on stderr, and how it ended.
import { spawn } from 'node:child_process'
import { parentPort, workerData } from 'node:worker_threads'
import { matte, opaque } from '@shaderera/core/host'
import { matte64 } from './matte64.ts'

/** What the CLI's thread sends. */
export type ToEncoder = { type: 'frame'; bytes: Uint8Array } | { type: 'end' } | { type: 'kill' }

/** What this thread sends back. */
export type FromEncoder =
  | { type: 'written' }
  | { type: 'stderr'; data: Uint8Array }
  | { type: 'error'; message: string }
  | { type: 'close'; code: number | null; signal: NodeJS.Signals | null }

/** What the thread starts with. */
export type EncoderData = {
  bin: string
  args: string[]
  /** How the frames are matted over black: straight RGBA at 8 or 16 bits, or not at all. */
  matte: 'rgba' | 'rgba64' | null
}

const port = parentPort
if (port) {
  const o = workerData as EncoderData
  const say = (m: FromEncoder) => port.postMessage(m)
  const ff = spawn(o.bin, o.args, { stdio: ['pipe', 'ignore', 'pipe'] })
  ff.stderr.on('data', (data: Buffer) => say({ type: 'stderr', data }))
  ff.once('error', (error) => say({ type: 'error', message: error.message }))
  // 'close', not 'exit': stderr has been read to its end.
  ff.once('close', (code, signal) => {
    say({ type: 'close', code, signal })
    port.close()
  })
  // An ffmpeg that exits early closes the pipe: the write fails with EPIPE, and `close` says why.
  ff.stdin.on('error', () => {})
  port.on('message', (m: ToEncoder) => {
    if (m.type === 'end') return void ff.stdin.end()
    if (m.type === 'kill') return void ff.kill()
    // Straight RGBA over black, unless every pixel is opaque (the matte would give the same bytes).
    const bytes =
      o.matte === 'rgba'
        ? opaque(m.bytes)
          ? m.bytes
          : matte(m.bytes)
        : o.matte === 'rgba64'
          ? matte64(m.bytes)
          : m.bytes
    if (ff.stdin.write(bytes)) say({ type: 'written' })
    else ff.stdin.once('drain', () => say({ type: 'written' }))
  })
}
