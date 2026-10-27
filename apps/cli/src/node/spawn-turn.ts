// Why the CLI's worker threads start their processes in turns (#439).
//
// On Windows a new process inherits every inheritable handle of the process that starts it
// (CreateProcess with bInheritHandles), and libuv makes the child's end of each stdio pipe
// inheritable until that child has started. Within one thread spawns come one at a time, but a
// worker thread has a libuv loop of its own: a process it starts while the CLI's thread is
// starting another inherits that other's pipe ends. In #439 the encoder's ffmpeg (started by
// cli/encoder.ts) took the write end of a chunk decoder's stdout; the decoder exited, its stdout
// never ended, and a render waited for 2.5 hours. Node 24.14.1, a worker starting long-lived
// processes while the CLI's thread starts short ones: 3 of 165 short ones' stdout never ended
// (0 of 276 without the worker); the hdr10 render with its two spawns aligned hung 29 of 128.
//
// So a worker takes a turn for each spawn: it asks the CLI's thread, which, between two events
// (in no spawn of its own, sync or not), waits until the worker's spawn has returned. The turn is
// the spawn call only. Two workers' turns come one after the other: the CLI's thread grants one
// at a time.
import { MessageChannel, type MessagePort } from 'node:worker_threads'

/** What a worker thread takes its turns with: passed in its workerData (transfer the port). */
export type SpawnTurn = { flag: Int32Array; port: MessagePort }

const FREE = 0
const GRANTED = 1
const DONE = 2

/**
 * How long the CLI's thread waits for a worker's spawn (a few ms; more on a loaded machine)
 * before it takes the turn back: a worker that dies or hangs in its turn stops nothing.
 */
export const HOLD_MS = 2_000

/**
 * How long a worker waits for its turn before it spawns anyway: the CLI's thread is then in a
 * long synchronous call (a spawnSync), whose own spawn is long over.
 */
export const ASK_MS = 10_000

/**
 * The CLI's thread: turns for one new worker, and the port to list in its `transferList`. `holdMs`:
 * HOLD_MS but for tests.
 */
export const lendTurns = (holdMs = HOLD_MS): { turn: SpawnTurn; transfer: MessagePort[] } => {
  const flag = new Int32Array(new SharedArrayBuffer(4))
  const { port1, port2 } = new MessageChannel()
  port1.on('message', () => {
    Atomics.store(flag, 0, GRANTED)
    Atomics.notify(flag, 0)
    Atomics.wait(flag, 0, GRANTED, holdMs)
    Atomics.store(flag, 0, FREE)
    Atomics.notify(flag, 0)
  })
  // An idle worker's turns do not keep the CLI running.
  port1.unref()
  return { turn: { flag, port: port2 }, transfer: [port2] }
}

/**
 * A worker thread: runs `spawn` (the spawn call, nothing more) in its turn. Without turns (the
 * CLI's own thread, a test) it runs at once.
 */
export const spawnInTurn = <T>(turn: SpawnTurn | undefined, spawn: () => T): T => {
  if (!turn) return spawn()
  turn.port.unref()
  // A turn the CLI's thread took back (DONE or FREE left over) is not this one.
  turn.port.postMessage(0)
  const until = performance.now() + ASK_MS
  for (let v = Atomics.load(turn.flag, 0); v !== GRANTED; v = Atomics.load(turn.flag, 0)) {
    const left = until - performance.now()
    if (left <= 0) break
    Atomics.wait(turn.flag, 0, v, left)
  }
  try {
    return spawn()
  } finally {
    Atomics.store(turn.flag, 0, DONE)
    Atomics.notify(turn.flag, 0)
  }
}
