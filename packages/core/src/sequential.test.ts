import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Manifest, Matrices, Source } from './protocol.ts'
import { seekable } from './sequential.ts'

const manifest: Manifest = { entry: 'x', fps: 10, duration: 2, width: 1, height: 1 }

/** A simulation: each render is one step, and what it shows is how many steps it took. */
const simulation = (log: string[]) => async (): Promise<Source> => {
  let steps = 0
  let last = -1
  let camera: Matrices | null = null
  log.push('open')
  return {
    render: async (t, o) => {
      if (t <= last) throw new Error(`rendered ${t} after ${last}`)
      last = t
      steps += 1
      log.push(`${o.intent[0]}${Math.round(t * 10)}`)
      return { color: new Uint8Array([steps, 0, 0, 255]), alpha: 'opaque' }
    },
    inspect: async (t) => ({ t, steps, camera: camera !== null }),
    pick: async () => ({ id: `step-${steps}` }),
    camera: {
      get: async () => ({ view: [steps], projection: [] }),
      override: (m) => {
        camera = m
      },
    },
  }
}

const shown = async (s: Source, t: number, intent: 'preview' | 'final' = 'final') => {
  const frame = await s.render(t, { width: 1, height: 1, intent, frame: Math.round(t * 10) })
  return ((frame as { color: Uint8Array }).color[0] as number) - 1
}

test('a sequential source answers any t as if it had stepped there from frame 0', async () => {
  const log: string[] = []
  const s = await seekable(simulation(log), manifest)
  const random = [7, 3, 3, 12, 0, 19, 5, 5, 18, 1]
  for (const frame of random) {
    const t = frame / 10
    assert.equal(await shown(s, t), frame, `render at frame ${frame}`)
    assert.deepEqual(await s.inspect?.(t), { t, steps: frame + 1, camera: false })
    assert.deepEqual(await s.pick?.(t, 0, 0), { id: `step-${frame + 1}` })
    assert.deepEqual((await s.camera?.get(t))?.view, [frame + 1])
  }
})

test('queries at t bring the source through t; going back opens it again', async () => {
  const log: string[] = []
  const s = await seekable(simulation(log), manifest)
  assert.deepEqual(await s.inspect?.(0.2), { t: 0.2, steps: 3, camera: false })
  assert.deepEqual(log, ['open', 'p0', 'p1', 'p2'])
  log.length = 0
  assert.equal(await shown(s, 0.3, 'final'), 3)
  assert.deepEqual(log, ['f3'])
  log.length = 0
  assert.equal(await shown(s, 0.3, 'preview'), 3)
  assert.deepEqual(log, ['open', 'p0', 'p1', 'p2', 'p3'])
  log.length = 0
  assert.equal(await shown(s, 0.3, 'final'), 3)
  assert.deepEqual(log, ['open', 'p0', 'p1', 'p2', 'f3'])
})

test('the free camera survives a replay', async () => {
  const s = await seekable(simulation([]), manifest)
  await shown(s, 0.5)
  s.camera?.override?.({ view: [], projection: [] })
  assert.deepEqual(await s.inspect?.(0.1), { t: 0.1, steps: 2, camera: true })
})

/** Seeded particles stepped at a fixed dt: a state that only replay or a checkpoint recovers. */
const particles =
  (log: string[], o: { seed: number; cost?: number }) => async (): Promise<Source> => {
    let rng = o.seed >>> 0
    const random = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0
      return rng / 2 ** 32
    }
    let state = Float64Array.from({ length: 64 }, random)
    let frames = 0
    log.push('open')
    return {
      render: async (_t, options) => {
        // One fixed step per frame, from the frame index: never a wall-clock delta.
        for (let i = 0; i < state.length; i += 2) {
          state[i] = ((state[i] as number) + 0.01 * (state[i + 1] as number) + random() * 1e-3) % 1
        }
        frames += 1
        log.push(`r${options.frame}`)
        const busy = performance.now() + (o.cost ?? 0)
        while (performance.now() < busy) {}
        const sum = state.reduce((a, b) => a + b, 0)
        return { color: new Float32Array([sum, frames]) as never, alpha: 'opaque' }
      },
      checkpoint: {
        save: async () => ({ state: state.slice(), rng, frames }),
        restore: async (saved) => {
          const s = saved as { state: Float64Array; rng: number; frames: number }
          state = s.state.slice()
          rng = s.rng
          frames = s.frames
          log.push('restore')
        },
      },
      camera: { get: async () => ({ view: [], projection: [] }), override: () => {} },
    }
  }

const value = async (s: Source, f: number) => {
  const frame = await s.render(f / 10, { width: 1, height: 1, intent: 'final', frame: f })
  return [...(frame as unknown as { color: Float32Array }).color]
}

test('a seeded simulation shows the same frame however it is reached', async () => {
  const log: string[] = []
  const open = particles(log, { seed: 7, cost: 2 })
  const target = 15
  const sequential = await seekable(open, manifest, { checkpointMs: 0 })
  let played: number[] = []
  for (let f = 0; f <= target; f++) played = await value(sequential, f)
  const direct = await value(await seekable(open, manifest), target)
  const backward = await seekable(open, manifest, { checkpointMs: 5 })
  await value(backward, 19)
  const back = await value(backward, target)
  // Looping: the end, then frame 0 and on to the target again.
  await value(backward, 0)
  const looped = await value(backward, target)
  const reset = await value(await seekable(open, manifest), target)
  assert.deepEqual(direct, played)
  assert.deepEqual(back, played)
  assert.deepEqual(looped, played)
  assert.deepEqual(reset, played)
  assert.equal(played[1], target + 1, 'the frame is the 16th step')
})

test('going back restores the latest checkpoint before the frame instead of replaying', async () => {
  const log: string[] = []
  const s = await seekable(particles(log, { seed: 1, cost: 3 }), manifest, { checkpointMs: 5 })
  await value(s, 19)
  log.length = 0
  await value(s, 10)
  assert.ok(!log.includes('open'), log.join(' '))
  assert.equal(log[0], 'restore')
  assert.ok(log.length <= 4, `restored near the frame: ${log.join(' ')}`)
  const { opened, restored, kept } = s.stats()
  assert.deepEqual({ opened, restored }, { opened: 1, restored: 1 })
  assert.ok(kept > 0)
})

/** Feedback whose step depends on the camera: 1 per frame without an override, 10 with one. */
const cameraFeedback = (log: string[]) => async (): Promise<Source> => {
  let state = 0
  let camera = false
  log.push('open')
  return {
    render: async () => {
      state += camera ? 10 : 1
      return { color: new Float32Array([state]) as never, alpha: 'opaque' }
    },
    camera: {
      get: async () => ({ view: [], projection: [] }),
      override: (m) => {
        camera = m !== null
      },
    },
    checkpoint: {
      save: async () => state,
      restore: async (saved) => {
        state = saved as number
        log.push('restore')
      },
    },
  }
}

test('a new camera drops state made under the old one: equal to a fresh source under it', async () => {
  const log: string[] = []
  const view = { view: [1], projection: [] }
  const s = await seekable(cameraFeedback(log), manifest, { checkpointMs: 0 })
  await value(s, 1)
  s.camera?.override?.(view)
  log.length = 0
  const switched = await value(s, 2)
  assert.equal(log[0], 'open', 'replayed from frame 0, no old-camera checkpoint restored')
  const fresh = await seekable(cameraFeedback([]), manifest)
  fresh.camera?.override?.(view)
  assert.deepEqual(switched, await value(fresh, 2))
  assert.deepEqual(switched, [30])
  // The same camera again is not a change; back to none replays again.
  log.length = 0
  s.camera?.override?.(view)
  await value(s, 3)
  assert.ok(!log.includes('open'))
  s.camera?.override?.(null)
  assert.deepEqual(await value(s, 3), [4])
})

test('at the cap, every other checkpoint goes and the spacing doubles', async () => {
  const s = await seekable(particles([], { seed: 1 }), manifest, {
    checkpointMs: 0,
    maxCheckpoints: 4,
  })
  await value(s, 19)
  assert.ok(s.stats().kept <= 4)
  assert.ok(s.stats().saved > 4)
  assert.deepEqual(
    await value(s, 9),
    await value(await seekable(particles([], { seed: 1 }), manifest), 9),
  )
})

test('a step that fails or is cancelled leaves no half-stepped state behind', async () => {
  const log: string[] = []
  let fail = true
  const open = async (): Promise<Source> => {
    const inner = await particles(log, { seed: 3 })()
    return {
      ...inner,
      render: async (t, o) => {
        if (o.frame === 8 && fail) {
          await inner.render(t, o) // the state moved, then the step threw
          throw new Error('device lost')
        }
        o.signal?.throwIfAborted()
        return inner.render(t, o)
      },
    }
  }
  const s = await seekable(open, manifest)
  await assert.rejects(value(s, 10), /device lost/)
  fail = false
  log.length = 0
  assert.deepEqual(await value(s, 10), await value(await seekable(open, manifest), 10))
  assert.equal(log[0], 'open', 'the next call reopened rather than going on from the failure')

  const cancelled = new AbortController()
  cancelled.abort(new Error('superseded'))
  await assert.rejects(
    s.render(1.2, { width: 1, height: 1, intent: 'preview', frame: 12, signal: cancelled.signal }),
    /superseded/,
  )
  assert.deepEqual(await value(s, 12), await value(await seekable(open, manifest), 12))
})

test('a checkpoint that cannot be restored fails the call, naming it', async () => {
  const open = async (): Promise<Source> => {
    const inner = await particles([], { seed: 3 })()
    return {
      ...inner,
      checkpoint: {
        save: (inner.checkpoint as NonNullable<Source['checkpoint']>).save,
        restore: async () => {
          throw new Error('buffer size changed')
        },
      },
    }
  }
  const s = await seekable(open, manifest, { checkpointMs: 0 })
  await value(s, 10)
  await assert.rejects(value(s, 5), /checkpoint\.restore to frame 4 failed: .*buffer size changed/)
})

test('checkpoints are plain data: a copy restores into a source opened anew', async () => {
  const open = particles([], { seed: 5 })
  const a = await open()
  for (let f = 0; f < 6; f++)
    await a.render(f / 10, { width: 1, height: 1, intent: 'preview', frame: f })
  const saved = structuredClone(await a.checkpoint?.save())
  const b = await open()
  await b.checkpoint?.restore(saved)
  const next = (s: Source) => s.render(0.6, { width: 1, height: 1, intent: 'final', frame: 6 })
  assert.deepEqual(await next(b), await next(a))
})

test('an off-grid t renders the nearest frame; frame 0 is the first step', async () => {
  const s = await seekable(particles([], { seed: 9 }), manifest)
  const frame = (await s.render(0.349, {
    width: 1,
    height: 1,
    intent: 'final',
    frame: 3,
  })) as unknown as {
    color: Float32Array
  }
  assert.equal(frame.color[1], 4, 'frame 3 is the 4th step')
  const zero = (await (
    await seekable(particles([], { seed: 9 }), manifest)
  ).render(0, {
    width: 1,
    height: 1,
    intent: 'final',
    frame: 0,
  })) as unknown as { color: Float32Array }
  assert.equal(zero.color[1], 1)
})

test('a disposed source refuses further calls and keeps no checkpoints', async () => {
  const s = await seekable(particles([], { seed: 1 }), manifest, { checkpointMs: 0 })
  await value(s, 5)
  s.dispose?.()
  assert.equal(s.stats().kept, 0)
  await assert.rejects(value(s, 6), /disposed/)
})

/** A fake DOM bitmap: which t it was drawn at, and whether the host closed it. */
type FakeDom = { t: number; closed: boolean; close(): void }
const domAt = (made: FakeDom[]) => async (t: number) => {
  const dom: FakeDom = {
    t,
    closed: false,
    close() {
      this.closed = true
    },
  }
  made.push(dom)
  return { dom: dom as unknown as ImageBitmap }
}

/** State that integrates the DOM it is shown: each frame adds the frame number its DOM shows. */
const domFeedback = (seen: number[]) => async (): Promise<Source> => {
  let state = 0
  return {
    render: async (t, o) => {
      const dom = o.dom as unknown as FakeDom | undefined
      if (!dom) throw new Error(`no DOM at t=${t}`)
      if (dom.closed) throw new Error('a closed DOM')
      seen.push(Math.round(dom.t * 10))
      state = state * 0.5 + Math.round(dom.t * 10)
      return { color: new Float32Array([state]) as never, alpha: 'opaque' }
    },
    inspect: async () => ({ state }),
  }
}

/** The host's part: the requested frame's own DOM, closed after the frame is composited. */
const hostRender = async (s: Source, f: number, made: FakeDom[], signal?: AbortSignal) => {
  const { dom } = await domAt(made)(f / 10)
  try {
    const frame = await s.render(f / 10, {
      width: 1,
      height: 1,
      intent: 'final',
      frame: f,
      dom,
      ...(signal ? { signal } : {}),
    })
    return [...(frame as unknown as { color: Float32Array }).color]
  } finally {
    dom.close()
  }
}

test('every stepped frame gets its own DOM, closed after it; the same state however it is reached', async () => {
  const made: FakeDom[] = []
  const seen: number[] = []
  const open = domFeedback(seen)
  const prepare = domAt(made)
  const play = await seekable(open, manifest, { prepare })
  let played: number[] = []
  for (let f = 0; f <= 8; f++) played = await hostRender(play, f, made)
  const direct = await seekable(open, manifest, { prepare })
  seen.length = 0
  assert.deepEqual(await hostRender(direct, 8, made), played, 'direct seek')
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8], 'each step saw its own frame, not frame 8')
  assert.deepEqual(await hostRender(direct, 8, made), played, 'the same frame again')
  await hostRender(direct, 12, made)
  assert.deepEqual(await hostRender(direct, 8, made), played, 'backward seek')
  await hostRender(direct, 19, made)
  await hostRender(direct, 0, made)
  assert.deepEqual(await hostRender(direct, 8, made), played, 'loop')
  assert.ok(
    made.every((d) => d.closed),
    'every DOM bitmap was closed',
  )
})

test('inspection steps through the same preparation and agrees with the render', async () => {
  const made: FakeDom[] = []
  const prepare = domAt(made)
  const a = await seekable(domFeedback([]), manifest, { prepare })
  const inspected = await a.inspect?.(0.6)
  const b = await seekable(domFeedback([]), manifest, { prepare })
  const [rendered] = await hostRender(b, 6, made)
  assert.deepEqual(inspected, { state: rendered })
  assert.ok(made.every((d) => d.closed))
})

test('a cancelled seek stops between frames and the source goes on from where it stopped', async () => {
  const made: FakeDom[] = []
  const seen: number[] = []
  const abort = new AbortController()
  const prepare = async (t: number, signal?: AbortSignal) => {
    if (Math.round(t * 10) === 4) abort.abort(new Error('superseded'))
    return domAt(made)(t)
  }
  const s = await seekable(domFeedback(seen), manifest, { prepare })
  await assert.rejects(hostRender(s, 9, made, abort.signal), /superseded/)
  assert.deepEqual(seen, [0, 1, 2, 3], 'no frame after the cancel was rendered')
  assert.ok(
    made.every((d) => d.closed),
    'the frame prepared when it was cancelled was closed too',
  )
  seen.length = 0
  const after = await hostRender(s, 9, made)
  assert.deepEqual(seen, [4, 5, 6, 7, 8, 9], 'went on from frame 4, no replay')
  assert.deepEqual(
    after,
    await hostRender(await seekable(domFeedback([]), manifest, { prepare: domAt(made) }), 9, made),
  )
})
