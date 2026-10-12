import { type DeterminismFailure, revisit, samples, type Visit } from './determinism.ts'
import { sha256 } from './hash.ts'
import type { Json } from './protocol.ts'
import { frameTimes } from './time.ts'

/** Where exported frames go, one RGBA buffer at a time. */
export type Sink = {
  write(pixels: Uint8Array | Uint8ClampedArray): Promise<void>
  end(): Promise<void>
  /** Discards what was written: the export failed. */
  abort?(): Promise<void>
}

/** How many exported frames are rendered again, in another order, before the sink may end. */
const RECHECKED = 8

const describe = (failures: readonly DeterminismFailure[]): string =>
  failures
    .slice(0, 3)
    .map((f) => {
      const what = f.kind === 'pixels' ? 'pixels' : f.changes.map((c) => c.path).join(', ')
      return `t=${f.t} after t=${f.after}: ${what}`
    })
    .join('; ')

/**
 * Renders every frame in [from, to) in order into a sink, waiting on each write. The export is also
 * the first pass of a determinism check: before the sink ends, up to 8 of its frames (the first, the
 * last and seeded picks) are rendered again in a shuffled order. If any changed, the sink is
 * aborted and this throws, because a source that fails the check may play but cannot export.
 */
export const exportFrames = async (o: {
  fps: number
  from: number
  to: number
  render: (t: number) => Promise<Uint8Array | Uint8ClampedArray>
  /** Compared too, on the frames rendered again. */
  inspect?: (t: number) => Promise<Json>
  sink: Sink
  signal?: AbortSignal
  onFrame?: (index: number, total: number, t: number) => void
  /**
   * How many frames may be rendering at once (1 by default): `render` is called in frame order
   * and the sink still gets them in order. More than 1 only for a render that spreads frames over
   * several hosts; a frame's `inspect` then runs after later frames were asked for.
   */
  ahead?: number
}): Promise<{ readonly frames: number }> => {
  const times = frameTimes(o.fps, o.from, o.to)
  const checked = new Set(samples(times, RECHECKED))
  const first = new Map<number, Visit>()
  const ahead = Math.max(1, Math.floor(o.ahead ?? 1))
  const asked = new Map<number, Promise<Uint8Array | Uint8ClampedArray>>()
  const ask = (index: number) => {
    const t = times[index]
    if (t === undefined || asked.has(index)) return
    const pixels = o.render(t)
    // Awaited in order below; a later one that fails before then must not go unhandled.
    pixels.catch(() => {})
    asked.set(index, pixels)
  }
  try {
    for (let i = 0; i < ahead; i++) ask(i)
    for (const [index, t] of times.entries()) {
      o.signal?.throwIfAborted()
      ask(index)
      const pixels = await (asked.get(index) as Promise<Uint8Array | Uint8ClampedArray>)
      asked.delete(index)
      if (checked.has(t)) {
        const hash = await sha256(pixels)
        first.set(t, { hash, json: o.inspect ? await o.inspect(t) : undefined })
      }
      // After the frame's inspect: with one frame at a time, the source has not moved on.
      ask(index + ahead)
      await o.sink.write(pixels)
      o.onFrame?.(index, times.length, t)
    }
    o.signal?.throwIfAborted()
    const failures = await revisit(first, o, times.at(-1) ?? null)
    if (failures.length > 0) {
      throw new Error(`Not exported: the source is not deterministic (${describe(failures)}).`)
    }
    await o.sink.end()
  } catch (error) {
    await o.sink.abort?.()
    throw error
  }
  return { frames: times.length }
}
