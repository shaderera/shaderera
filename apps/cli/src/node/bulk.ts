// Frames between the CLI's process and a Node host go on a pipe of their own beside IPC: IPC
// serializes them (a copy) and writes them in the sender's thread, which, with every host's frames
// and video frames passing through the CLI's one thread, was what a render waited on (#434). The
// pipe takes the bytes as they are. Each payload is announced on IPC by its length, written to the
// pipe in the same turn, so the payloads come off the pipe in the order they were announced.
import type { Readable } from 'node:stream'

/** The child's stdio index of the pipe. */
export const BULK_FD = 4

/** Bytes from this length on go on the pipe; shorter ones stay in the IPC message. */
export const BULK_MIN = 1 << 16

/** Whether a value goes on the pipe: bytes of at least BULK_MIN. */
export const isBulk = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.byteLength >= BULK_MIN

/**
 * Takes payloads off a pipe in the order their lengths are announced (`next`), each copied once
 * into its own bytes. Once the pipe closes (its process exited), a payload that has not fully
 * come fails.
 */
export const bulkReader = (pipe: Readable) => {
  const waiting: {
    length: number
    done: (bytes: Uint8Array) => void
    fail: (error: Error) => void
  }[] = []
  let parts: Buffer[] = []
  let held = 0
  let closed = false
  const settle = () => {
    for (;;) {
      const first = waiting[0]
      if (first && closed && held < first.length) {
        // What is left belongs to the payload that did not come whole: nothing after it is whole.
        parts = []
        held = 0
        for (const w of waiting.splice(0)) w.fail(new Error('The source process has exited.'))
        return
      }
      if (!first || held < first.length) return
      waiting.shift()
      const out = new Uint8Array(Buffer.allocUnsafeSlow(first.length).buffer, 0, first.length)
      let at = 0
      let used = 0
      while (at < first.length) {
        const part = parts[used] as Buffer
        const n = Math.min(part.length, first.length - at)
        out.set(n === part.length ? part : part.subarray(0, n), at)
        at += n
        if (n === part.length) used++
        else parts[used] = part.subarray(n)
      }
      parts = parts.slice(used)
      held -= first.length
      first.done(out)
    }
  }
  pipe.on('data', (d: Buffer) => {
    parts.push(d)
    held += d.length
    settle()
  })
  pipe.on('close', () => {
    closed = true
    settle()
  })
  return {
    /** The next payload, of `length` bytes. */
    next: (length: number) =>
      new Promise<Uint8Array>((done, fail) => {
        waiting.push({ length, done, fail })
        settle()
      }),
  }
}
