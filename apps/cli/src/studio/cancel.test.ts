import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { tempDir } from '../fixtures/temp.ts'
import { type Bridge, type StudioEvent, startBridge } from './bridge.ts'

const SITE = 'https://shaderera.example'

/** A film whose render never settles after 0.5 s when `hang` is set, as #376's repro. */
const hanging = () => {
  const root = tempDir('studio-hang')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 10,
      duration: 1,
      width: 16,
      height: 16,
      params: {
        type: 'object',
        properties: { hang: { type: 'boolean', default: false } },
      },
    }),
  )
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default ({ io, params }) => {
  const canvas = io.canvas(16, 16)
  return {
    render: async (t) => {
      if (params.hang && t > 0.5) await new Promise(() => {})
      canvas.getContext('2d').fillRect(0, 0, 16, 16)
      return { color: canvas }
    },
  }
}
`,
  )
  return root
}

/** Queues a png render through the bridge's routes; its job id. */
const png = async (b: Bridge, body: object) => {
  const reply = await b.handle({
    method: 'POST',
    path: '/render',
    body: { format: 'png', ...body },
  })
  assert.equal(reply.status, 200)
  return (reply as { json: { job: string } }).json.job
}

/** The bridge's job events from now on; `until` gives a job's first event in a state. */
const record = (b: Bridge) => {
  const seen: (StudioEvent & { type: 'job' })[] = []
  const waiting = new Set<() => void>()
  b.onEvent((e) => {
    if (e.type !== 'job') return
    seen.push(e)
    for (const w of waiting) w()
  })
  return (job: string, state: 'running' | 'done' | 'failed') =>
    new Promise<StudioEvent & { type: 'job' }>((done) => {
      const check = () => {
        const e = seen.find((s) => s.id === job && s.state === state)
        if (!e) return
        waiting.delete(check)
        done(e)
      }
      waiting.add(check)
      check()
    })
}

test('a hung frame fails its job within the timeout, naming t, and the next job runs', {
  timeout: 60_000,
}, async () => {
  const bridge = await startBridge({
    root: hanging(),
    api: SITE,
    site: SITE,
    origins: [SITE],
    hostFlags: { timeout: '5' },
  })
  const settled = record(bridge)
  try {
    const start = performance.now()
    const hung = await png(bridge, { t: 0.6, params: { hang: true } })
    const next = await png(bridge, { t: 0.6 })
    const failed = await settled(hung, 'failed')
    assert.match(failed.error ?? '', /took longer than 5000 ms on render at t = 0\.6 s/)
    await settled(next, 'done')
    assert.ok(performance.now() - start < 30_000)
  } finally {
    await bridge.close()
  }
})

test('POST /render/<job>/cancel ends a running or queued job as failed, and the next one runs', {
  timeout: 60_000,
}, async () => {
  const bridge = await startBridge({ root: hanging(), api: SITE, site: SITE, origins: [SITE] })
  const settled = record(bridge)
  try {
    const hung = await png(bridge, { t: 0.6, params: { hang: true } })
    const queued = await png(bridge, { t: 0 })
    const next = await png(bridge, { t: 0 })
    await settled(hung, 'running')
    // Into the frame that never settles (its build and open take about a second).
    await sleep(3000)
    const cancel = (job: string) => bridge.handle({ method: 'POST', path: `/render/${job}/cancel` })
    // The queued one first: it never runs.
    const failedQueued = settled(queued, 'failed')
    assert.equal((await cancel(queued)).status, 200)
    assert.match((await failedQueued).error ?? '', /cancelled/)
    const failedHung = settled(hung, 'failed')
    assert.equal((await cancel(hung)).status, 200)
    assert.match((await failedHung).error ?? '', /cancelled/)
    await settled(next, 'done')
    assert.equal((await cancel(next)).status, 409)
    assert.equal((await cancel('abcdef')).status, 404)
  } finally {
    await bridge.close()
  }
})
