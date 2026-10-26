import { type DeterminismFailure, revisit, type Visit } from './determinism.ts'
import { sha256 } from './hash.ts'
import type { Json } from './protocol.ts'
import { frameAt, frameTimes } from './time.ts'

/** Where exported frames go, one RGBA buffer at a time. */
export type Sink = {
  write(pixels: Uint8Array | Uint8ClampedArray): Promise<void>
  end(): Promise<void>
  /** Discards what was written: the export failed. */
  abort?(): Promise<void>
}

/** At most how many frames a sequential source's re-check renders again. */
const SEQUENTIAL_RECHECKS = 8

/**
 * The frames of `times` rendered again before the sink may end: the film's frames 0, n, 2n …, n its
 * frames a second (rounded), so one a second of film. They are picked by the film's frame number,
 * not by the window, so every frame a window re-checks is re-checked by any render that holds it
 * (the whole film, a chunk of a plan): a render and a window of it check the same frames (#447).
 */
const rechecked = (times: readonly number[], fps: number, sequential = false): number[] => {
  const every = Math.max(1, Math.round(fps))
  const grid = times.filter((t) => frameAt(t, fps) % every === 0)
  if (!sequential || grid.length <= SEQUENTIAL_RECHECKS) return grid
  // A sequential source reaches an earlier frame by replaying from frame 0 (or a checkpoint), so
  // each re-checked frame can cost the whole film: 8 of the grid, spread evenly, keep it fixed.
  return Array.from(
    { length: SEQUENTIAL_RECHECKS },
    (_, i) => grid[Math.round((i * (grid.length - 1)) / (SEQUENTIAL_RECHECKS - 1))] as number,
  )
}

const describe = (failures: readonly DeterminismFailure[]): string =>
  failures
    .slice(0, 3)
    .map((f) => {
      const what = f.kind === 'pixels' ? 'pixels' : f.changes.map((c) => c.path).join(', ')
      return `t=${f.t} after t=${f.after}: ${what}`
    })
    .join('; ')

/** An export refused because frames rendered again came out different: its frames cannot be trusted. */
export class NotDeterministic extends Error {
  readonly failures: readonly DeterminismFailure[]
  constructor(failures: readonly DeterminismFailure[]) {
    super(`Not exported: the source is not deterministic (${describe(failures)}).`)
    this.failures = failures
  }
}

/**
 * Renders every frame in [from, to) in order into a sink, waiting on each write. The export is also
 * the first pass of a determinism check: before the sink ends, its frames on the film's one-a-second
 * grid (`rechecked`) are rendered again in a shuffled order, split between the `hosts` (each
 * re-checks frames another host rendered first, so they must agree). If any changed, the sink is
 * aborted and this throws, because a source that fails the check may play but cannot export.
 */
export const exportFrames = async (o: {
  fps: number
  from: number
  to: number
  /** `host`: which of the `hosts` renders it, from 0. */
  render: (t: number, host: number) => Promise<Uint8Array | Uint8ClampedArray>
  /** Compared too, on the frames rendered again. */
  /** On the host that rendered the frame. */
  inspect?: (t: number, host: number) => Promise<Json>
  sink: Sink
  signal?: AbortSignal
  onFrame?: (index: number, total: number, t: number) => void
  /** Called after each frame the re-check rendered again, with its count so far (from 0). */
  onRecheck?: (index: number, total: number) => void
  /**
   * How many frames may be rendering at once (1 by default): `render` is called in frame order
   * and the sink still gets them in order. More than 1 only for a render that spreads frames over
   * several hosts; a frame's `inspect` then runs after later frames were asked for.
   */
  ahead?: number
  /**
   * How many hosts `render` spreads frames over (1 by default): the frames go round them in the
   * order they are asked for, and the re-check is split between them, run at once, each host
   * shuffling its share of frames another host rendered first.
   */
  hosts?: number
  /**
   * The source reaches a frame only by stepping from an earlier one (a `sequential` manifest):
   * its re-check is 8 frames of the grid at most, spread evenly over the window, so its cost
   * stays fixed instead of growing with the square of the film's length. A longer range then
   * may not re-check a frame a window inside it re-checks.
   */
  sequential?: boolean
  /**
   * How many of the first frames the sink already holds (a resumed export): they are neither
   * rendered nor written, except the ones the determinism re-check samples, which are rendered so
   * the check still covers the whole window.
   */
  skip?: number
}): Promise<{ readonly frames: number }> => {
  const times = frameTimes(o.fps, o.from, o.to)
  const checked = new Set(rechecked(times, o.fps, o.sequential))
  const first = new Map<number, Visit & { host: number }>()
  const hosts = Math.max(1, Math.floor(o.hosts ?? 1))
  // The host each re-checked frame went to first, and the last frame each host was asked for.
  const hostOf = new Map<number, number>()
  const last: (number | null)[] = Array.from({ length: hosts }, () => null)
  let next = 0
  const ahead = Math.max(1, Math.floor(o.ahead ?? 1))
  const skip = Math.max(0, Math.floor(o.skip ?? 0))
  // A skipped frame is rendered only for the re-check.
  const needed = (index: number) => index >= skip || checked.has(times[index] as number)
  const asked = new Map<number, Promise<Uint8Array | Uint8ClampedArray>>()
  const ask = (index: number) => {
    const t = times[index]
    if (t === undefined || asked.has(index) || !needed(index)) return
    const host = next++ % hosts
    if (checked.has(t)) hostOf.set(index, host)
    last[host] = t
    const pixels = o.render(t, host)
    // Awaited in order below; a later one that fails before then must not go unhandled.
    pixels.catch(() => {})
    asked.set(index, pixels)
  }
  try {
    for (let i = 0; i < ahead; i++) ask(i)
    for (const [index, t] of times.entries()) {
      o.signal?.throwIfAborted()
      if (!needed(index)) continue
      ask(index)
      const pixels = await (asked.get(index) as Promise<Uint8Array | Uint8ClampedArray>)
      asked.delete(index)
      if (checked.has(t)) {
        const hash = await sha256(pixels)
        const host = hostOf.get(index) as number
        const json = o.inspect ? await o.inspect(t, host) : undefined
        first.set(t, { hash, json, host })
      }
      // After the frame's inspect: with one frame at a time, the source has not moved on.
      ask(index + ahead)
      if (index < skip) continue
      await o.sink.write(pixels)
      o.onFrame?.(index, times.length, t)
    }
    o.signal?.throwIfAborted()
    const failures = await revisit(
      first,
      {
        render: o.render,
        inspect: o.inspect,
        hosts,
        signal: o.signal,
        onVisit: o.onRecheck && ((done, total) => o.onRecheck?.(done - 1, total)),
      },
      last,
    )
    if (failures.length > 0) {
      throw new NotDeterministic(failures)
    }
    await o.sink.end()
  } catch (error) {
    await o.sink.abort?.()
    throw error
  }
  return { frames: times.length }
}
