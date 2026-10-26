import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { renderTime, resetRenderTime, timeRender, timeVideo } from './render-time.ts'

test('io.video waits count as their union inside render: concurrent waits once, a prefetch outside render not at all', async () => {
  resetRenderTime()
  // The first render after a reset (its shaders compile) is left out.
  await timeRender(() => sleep(30))
  assert.deepEqual(renderTime(), { renders: 0, renderMs: 0, videoMs: 0 })

  // Two clips' frames awaited at once: 60 ms of waiting, not 120.
  await timeRender(async () => {
    await Promise.all([timeVideo(() => sleep(60)), timeVideo(() => sleep(60))])
  })
  const both = renderTime()
  assert.equal(both.renders, 1)
  assert.ok(both.videoMs >= 55 && both.videoMs < 90, `${both.videoMs}`)

  // A frame asked ahead at the end of a render comes between renders: none of it is waiting.
  let ahead: Promise<unknown> = Promise.resolve()
  await timeRender(async () => {
    await sleep(20)
    ahead = timeVideo(() => sleep(60))
  })
  await sleep(90)
  await timeRender(async () => {
    await ahead
  })
  const after = renderTime()
  assert.equal(after.renders, 3)
  assert.ok(after.videoMs - both.videoMs < 15, `${after.videoMs - both.videoMs}`)

  // A wait outside render (open's) is not counted either.
  await timeVideo(() => sleep(20))
  assert.equal(renderTime().videoMs, after.videoMs)
})
