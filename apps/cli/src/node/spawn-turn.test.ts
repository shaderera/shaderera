import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { lendTurns } from './spawn-turn.ts'

// HOLD_MS, shorter: the tests time it.
const HOLD_MS = 300

const fixture = new URL('./fixtures/turn-worker.ts', import.meta.url)
const now = () => performance.timeOrigin + performance.now()
const busy = (ms: number) => {
  for (const end = now() + ms; now() < end; );
}
type Ran = { start: number; end: number }

/** A fixture worker with turns of its own; `asking` runs (in this thread) when it is about to ask. */
const worker = (data: object, asking: () => void = () => {}) => {
  const { turn, transfer } = lendTurns(HOLD_MS)
  const w = new Worker(fixture, { workerData: { ...data, turn }, transferList: transfer })
  const ran = new Promise<Ran>((done, fail) => {
    w.on('message', (m: 'asking' | Ran) => (m === 'asking' ? asking() : done(m)))
    w.once('error', fail)
  })
  return { w, ran }
}

test("a worker's spawn waits while the CLI's thread is in the middle of something (a spawn of its own)", async () => {
  let busyUntil = 0
  const { w, ran } = worker({ mode: 'time' }, () => {
    busy(400)
    busyUntil = now()
  })
  const r = await ran
  assert.ok(r.start >= busyUntil, `the spawn ran ${busyUntil - r.start} ms inside the busy time`)
  await w.terminate()
})

test("two workers' spawns come one after the other", async () => {
  const a = worker({ mode: 'time', hold: 300 })
  const b = worker({ mode: 'time', hold: 300 })
  const [x, y] = await Promise.all([a.ran, b.ran])
  assert.ok(x.end <= y.start || y.end <= x.start, JSON.stringify({ x, y }))
  await Promise.all([a.w.terminate(), b.w.terminate()])
})

/** The longest this thread went without running a timer, over `ms`. */
const longestGap = async (ms: number) => {
  let last = now()
  let gap = 0
  const tick = setInterval(() => {
    gap = Math.max(gap, now() - last)
    last = now()
  }, 10)
  await new Promise((done) => setTimeout(done, ms))
  clearInterval(tick)
  return gap
}

test("a worker that hangs in its turn holds the CLI's thread for HOLD_MS at most", async () => {
  const { w } = worker({ mode: 'hang' })
  const gap = await longestGap(HOLD_MS + 700)
  assert.ok(gap >= HOLD_MS - 100, `held for ${gap} ms`)
  assert.ok(gap < HOLD_MS + 500, `held for ${gap} ms`)
  await w.terminate()
})

test('a worker that exits in its turn does not stop the next one', async () => {
  const gone = worker({ mode: 'exit' })
  await new Promise((done) => gone.w.once('exit', done))
  const start = now()
  const next = worker({ mode: 'time' })
  await next.ran
  assert.ok(now() - start < HOLD_MS + 1500)
  await next.w.terminate()
})
