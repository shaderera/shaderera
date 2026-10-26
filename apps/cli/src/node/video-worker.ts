// The thread a clip's decoder runs in (services.ts, videoReader): it decodes, keeps the frames
// videoDecoder keeps, and sends each frame asked for as a copy of its own, moved, not copied
// again, to the CLI's thread.
import { parentPort, workerData } from 'node:worker_threads'
import { videoDecoder } from './decoder.ts'
import type { VideoInfo } from './services.ts'
import type { SpawnTurn } from './spawn-turn.ts'

/** What a reader asks: a frame, or the decoder's end. */
export type VideoAsk = { type: 'frame'; index: number } | { type: 'close' }

/** A request, with the window sizes the reader has now. */
export type ToVideo = { id: number; keep: number; ahead: number } & VideoAsk

/** An answer, with the decoder's process id after it (none once it ended). */
export type FromVideo = { id: number; pid: number | undefined; bytes?: Uint8Array; error?: string }

const port = parentPort
if (port) {
  const { file, info, turn } = workerData as { file: string; info: VideoInfo; turn?: SpawnTurn }
  let keep = 1
  let ahead = 1
  const decoder = videoDecoder(
    file,
    info,
    () => keep,
    () => ahead,
    turn,
  )
  port.on('message', async (m: ToVideo) => {
    keep = m.keep
    ahead = m.ahead
    try {
      if (m.type === 'close') {
        await decoder.close()
        return port.postMessage({ id: m.id, pid: decoder.pid } satisfies FromVideo)
      }
      // A copy: the decoder keeps its own for a frame asked again.
      const bytes = (await decoder.frame(m.index)).slice()
      port.postMessage({ id: m.id, pid: decoder.pid, bytes } satisfies FromVideo, [bytes.buffer])
    } catch (error) {
      port.postMessage({
        id: m.id,
        pid: decoder.pid,
        error: error instanceof Error ? error.message : String(error),
      } satisfies FromVideo)
    }
  })
}
