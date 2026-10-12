import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDeterminism, sampleTimes } from './determinism.ts'

test('checkDeterminism passes a pure source', async () => {
  const report = await checkDeterminism({
    times: [0.5, 0, 1],
    render: async (t) => new Uint8Array([t * 100, 0, 0, 255]),
    inspect: async (t) => ({ t }),
  })
  assert.deepEqual(report, { times: [0, 0.5, 1], failures: [] })
})

test('checkDeterminism catches state carried between frames', async () => {
  let last = 0
  let calls = 0
  const report = await checkDeterminism({
    times: [0, 1],
    render: async (t) => {
      const out = new Uint8Array([last, 0, 0, 255])
      last = t
      return out
    },
    inspect: async () => ({ calls: calls++ }),
  })
  assert.ok(report.failures.some((f) => f.kind === 'pixels'))
  assert.ok(report.failures.some((f) => f.kind === 'inspect' && f.changes[0]?.path === 'calls'))
  assert.equal(report.failures[0]?.after, null)
})

test('sampleTimes keeps the ends and draws distinct frames', () => {
  const times = sampleTimes(10, 1, 4)
  assert.equal(times.length, 4)
  assert.equal(times[0], 0)
  assert.equal(times[3], 0.9)
  assert.deepEqual(sampleTimes(10, 0.3, 9), [0, 0.1, 0.2])
  assert.deepEqual(sampleTimes(10, 1, 4), times)
})
