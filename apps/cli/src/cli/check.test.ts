import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Manifest } from '@shaderera/core'
import { boxFrame, memoryChild } from '../node/fixtures/memory-child.ts'
import { checkChild } from './check.ts'

const manifest = { fps: 10, duration: 1, width: 64, height: 36 } as Manifest
const size = { width: 64, height: 36 }

test('a check of fewer than two timestamps is refused: it could never fail', async () => {
  const child = memoryChild({ size })
  for (const times of [0, 1, Number.NaN, 2.5])
    await assert.rejects(checkChild(child, manifest, { times }), /2 or more/)
})

test('check passes a film that is a function of t, inspect included, and fails one with state', async () => {
  const film = memoryChild({ size, frame: boxFrame(64, 36), inspect: (t) => ({ x: 20 - 10 * t }) })
  const ok = await checkChild(film, manifest, { times: 5 })
  assert.deepEqual(ok.failures, [])
  assert.equal(ok.what, 'inspect + pixels')
  assert.deepEqual(ok.previewVsFinal, { mean: 0, max: 0, at: ok.previewVsFinal.at })
  assert.equal(ok.seeks, null)

  // Each frame a little brighter than the one before: a revisit gives other pixels.
  let n = 0
  const stateful = memoryChild({ size, frame: () => new Uint8Array(64 * 36 * 4).fill(n++) })
  const bad = await checkChild(stateful, manifest, { times: 5 })
  assert.ok(bad.failures.length > 0)
  assert.equal(bad.what, 'pixels')
})
