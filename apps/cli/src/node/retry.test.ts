import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportFrames, type Sink } from '@shaderera/core'
import type { Child } from './child.ts'
import { memoryChild } from './fixtures/memory-child.ts'
import { reopening, transientHost } from './open-host.ts'
import { withRetries } from './retry.ts'

const size = { width: 8, height: 4 }
const fps = 30
// A deterministic source: every byte a function of t.
const frame = (t: number) => new Uint8Array(8 * 4 * 4).fill(Math.round(t * fps) % 256)

/** Hosts of that source; the first one opened crashes at frame `at` and is dead from then on. */
const opener = (at?: number) => {
  let opens = 0
  const more = async (): Promise<Child> => {
    const host = memoryChild({ size, frame })
    if (opens++ > 0 || at === undefined) return host
    let dead = false
    return {
      ...host,
      render: async (t, intent, format) => {
        if (dead || Math.round(t * fps) === at) {
          dead = true
          throw new Error('The source process exited (3221225477).')
        }
        return host.render(t, intent, format)
      },
    }
  }
  return { more, opens: () => opens }
}

const collect = () => {
  const frames: Uint8Array[] = []
  const sink: Sink = {
    write: async (p) => void frames.push(Uint8Array.from(p)),
    end: async () => {},
  }
  return { frames, sink }
}

const render = async (hosts: Child[]) => {
  const { frames, sink } = collect()
  let next = 0
  await exportFrames({
    fps,
    from: 0,
    to: 1,
    render: async (t) =>
      (await (hosts[next++ % hosts.length] as Child).render(t, 'final', 'rgba')).pixels,
    sink,
    ahead: hosts.length * 2,
  })
  return frames
}

test('a host that crashes once at a frame is reopened with --retries 1: the frames are the same', async () => {
  const clean = await render([await opener().more()])
  const { more, opens } = opener(12)
  const warn = console.warn
  const lines: string[] = []
  console.warn = (line: string) => void lines.push(line)
  try {
    const first = reopening(await more(), more, { retries: 1, fps, delayMs: 1 })
    const second = reopening(await more(), more, { retries: 1, fps, delayMs: 1 })
    assert.deepEqual(await render([first, second]), clean)
  } finally {
    console.warn = warn
  }
  // Two hosts, and one reopened once, however many of its frames were in flight.
  assert.equal(opens(), 3)
  assert.match(lines[0] ?? '', /^! Frame 12 \(t 0\.4 s\) failed: The source process exited/)
  assert.match(lines[0] ?? '', /Retry 1\/1, on a reopened host/)
})

test('without --retries the crash fails the render as before', async () => {
  const { more } = opener(12)
  await assert.rejects(render([await more()]), /The source process exited/)
})

test('a source error is not retried, and the last retry throws the first error', async () => {
  let calls = 0
  await assert.rejects(
    withRetries(
      async () => {
        calls++
        throw new Error('io.bake: no such bake')
      },
      { retries: 3, transient: transientHost, what: 'x', delayMs: 1 },
    ),
    /no such bake/,
  )
  assert.equal(calls, 1)
  calls = 0
  const warn = console.warn
  console.warn = () => {}
  try {
    await assert.rejects(
      withRetries(
        async () => {
          throw new Error(`The source took longer than ${++calls} ms on render.`)
        },
        { retries: 2, transient: transientHost, what: 'x', delayMs: 1 },
      ),
      /longer than 1 ms/,
    )
  } finally {
    console.warn = warn
  }
  assert.equal(calls, 3)
})
