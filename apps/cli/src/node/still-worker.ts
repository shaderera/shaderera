// The thread a still is decoded in for every host (services.ts, decodeStill): a decode takes
// hundreds of milliseconds to seconds, which must not stall the CLI's thread that serves every
// host's video frames (ADR 0028, 1). It decodes once and ends, so its WASM memory goes with it.
import { parentPort, workerData } from 'node:worker_threads'
import { decodeImage } from '../runner/image.ts'

/** What the thread answers: the decoded RGBA bytes, or why not. */
export type FromStill = { data?: Uint8Array; error?: string }

const { bytes, path, maxSize } = workerData as { bytes: Uint8Array; path: string; maxSize?: number }
try {
  const data = new Uint8Array(decodeImage(bytes, path, maxSize).data.buffer)
  parentPort?.postMessage({ data } satisfies FromStill, [data.buffer as ArrayBuffer])
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  } satisfies FromStill)
}
