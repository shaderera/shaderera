import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportFrames } from './export.ts'

const recorder = () => {
  const log: string[] = []
  return {
    log,
    sink: {
      write: async (p: Uint8Array) => void log.push(`w${p[0]}`),
      end: async () => void log.push('end'),
    },
  }
}

test('exportFrames writes each frame in order and ends', async () => {
  const { log, sink } = recorder()
  const seen: number[] = []
  const result = await exportFrames({
    fps: 2,
    from: 0,
    to: 1.5,
    render: async (t) => new Uint8Array([t * 10]),
    sink,
    onFrame: (i, total) => seen.push(i, total),
  })
  assert.deepEqual(result, { frames: 3 })
  assert.deepEqual(log, ['w0', 'w5', 'w10', 'end'])
  assert.deepEqual(seen, [0, 3, 1, 3, 2, 3])
})

test('exportFrames stops on abort without ending', async () => {
  const { log, sink } = recorder()
  const controller = new AbortController()
  const reason = new Error('stop')
  await assert.rejects(
    exportFrames({
      fps: 1,
      from: 0,
      to: 5,
      render: async () => new Uint8Array([1]),
      sink,
      signal: controller.signal,
      onFrame: () => controller.abort(reason),
    }),
    reason,
  )
  assert.deepEqual(log, ['w1'])
})

test('exportFrames refuses a source whose frames depend on what came before, and aborts the sink', async () => {
  const { log, sink } = recorder()
  let last = 0
  await assert.rejects(
    exportFrames({
      fps: 10,
      from: 0,
      to: 1,
      render: async (t) => {
        const out = new Uint8Array([last * 10])
        last = t
        return out
      },
      sink: { ...sink, abort: async () => void log.push('abort') },
    }),
    /not deterministic \(t=[\d.]+ after t=[\d.]+: pixels/,
  )
  assert.equal(log.length, 11)
  assert.equal(log.at(-1), 'abort')
})

test('exportFrames compares inspect on the frames it renders again', async () => {
  const { log, sink } = recorder()
  let calls = 0
  await assert.rejects(
    exportFrames({
      fps: 1,
      from: 0,
      to: 3,
      render: async () => new Uint8Array([1]),
      inspect: async () => ({ calls: calls++ }),
      sink,
    }),
    /: calls\)/,
  )
  assert.ok(!log.includes('end'))
})

test('exportFrames with frames ahead asks in order and writes in order, however they finish', async () => {
  const { log, sink } = recorder()
  const asked: number[] = []
  let inFlight = 0
  let most = 0
  await exportFrames({
    fps: 1,
    from: 0,
    to: 6,
    ahead: 3,
    render: async (t) => {
      asked.push(t)
      most = Math.max(most, ++inFlight)
      // Later frames finish first.
      await new Promise((done) => setTimeout(done, (6 - t) * 3))
      inFlight--
      return new Uint8Array([t])
    },
    sink,
  })
  assert.deepEqual(asked.slice(0, 6), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(log.slice(0, 6), ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'])
  assert.equal(most, 3)
})
