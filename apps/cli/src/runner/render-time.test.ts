import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { renderTime, resetRenderTime, timeRender, timeVideo } from './render-time.ts'

// Relations, not wall-clock windows: the machine may be loaded (#482).
const timed = async (run: () => Promise<unknown>) => {
  const start = performance.now()
  await run()
  return performance.now() - start
}

test('io.video waits count as their union inside render: concurrent waits once, a prefetch outside render not at all', async () => {
  resetRenderTime()
  // The first render after a reset (its shaders compile) is left out.
  await timeRender(() => sleep(30))
  assert.deepEqual(renderTime(), { renders: 0, renderMs: 0, videoMs: 0 })

  // Two clips' frames awaited at once count once: about half the two waits added, never both.
  const waits: number[] = []
  await timeRender(async () => {
    await Promise.all(
      [0, 1].map(async (i) => (waits[i] = await timed(() => timeVideo(() => sleep(60))))),
    )
  })
  const both = renderTime()
  assert.equal(both.renders, 1)
  assert.ok(
    both.videoMs > 0 && both.videoMs <= both.renderMs,
    `${both.videoMs} of ${both.renderMs}`,
  )
  assert.ok(both.videoMs < 0.75 * (waits[0]! + waits[1]!), `${both.videoMs} vs ${waits}`)

  // A frame asked ahead at the end of a render comes between renders: none of it is waiting.
  let come = () => {}
  let ahead: Promise<unknown> = Promise.resolve()
  await timeRender(async () => {
    await sleep(20)
    ahead = timeVideo(() => new Promise<void>((resolve) => (come = resolve)))
  })
  const between = await timed(async () => {
    await sleep(60)
    come()
    await ahead
  })
  await timeRender(async () => {
    await ahead
  })
  const after = renderTime()
  assert.equal(after.renders, 3)
  assert.ok(
    after.videoMs - both.videoMs < between / 2,
    `${after.videoMs - both.videoMs} of ${between}`,
  )

  // A wait outside render (open's) is not counted either.
  await timeVideo(() => sleep(20))
  assert.equal(renderTime().videoMs, after.videoMs)
})
