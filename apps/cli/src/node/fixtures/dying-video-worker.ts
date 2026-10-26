// A clip's decoder thread that dies while it is asked to close: what services.test.ts disposes.
import { parentPort } from 'node:worker_threads'

parentPort?.on('message', (m: { id: number; type: string }) => {
  if (m.type === 'close') process.exit(1)
  parentPort?.postMessage({ id: m.id, pid: undefined, bytes: new Uint8Array(4) })
})
