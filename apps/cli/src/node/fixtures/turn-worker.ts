// A worker thread that takes spawn turns (spawn-turn.ts) for spawn-turn.test.ts. Its `spawn` does
// no spawning: it says when it ran (`hold` ms busy), hangs in its turn, or exits in it.
import { parentPort, workerData } from 'node:worker_threads'
import { type SpawnTurn, spawnInTurn } from '../spawn-turn.ts'

const { turn, mode, hold } = workerData as {
  turn: SpawnTurn
  mode: 'time' | 'hang' | 'exit'
  hold?: number
}
const port = parentPort
const now = () => performance.timeOrigin + performance.now()
const sleep = (n: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n)
if (port) {
  // Said first, a little before it asks: the test keeps the CLI's thread busy meanwhile.
  port.postMessage('asking')
  sleep(50)
  const ran = spawnInTurn(turn, () => {
    const start = now()
    if (mode === 'hang') sleep(60_000)
    if (mode === 'exit') process.exit(0)
    sleep(hold ?? 0)
    return { start, end: now() }
  })
  port.postMessage(ran)
}
