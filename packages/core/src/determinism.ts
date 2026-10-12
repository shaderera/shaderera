import { diffJson, type JsonChange } from './diff-json.ts'
import { sha256 } from './hash.ts'
import type { Json } from './protocol.ts'
import { frameTimes } from './time.ts'

/** A t whose inspect JSON or pixels changed when it was reached after a different t. */
export type DeterminismFailure =
  | {
      readonly kind: 'inspect'
      readonly t: number
      readonly after: number | null
      readonly changes: readonly JsonChange[]
    }
  | {
      readonly kind: 'pixels'
      readonly t: number
      readonly after: number | null
      readonly first: string
      readonly second: string
    }

export type DeterminismReport = {
  readonly times: readonly number[]
  readonly failures: readonly DeterminismFailure[]
}

/** mulberry32: a small seeded PRNG giving numbers in [0, 1). */
const random = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let x = Math.imul(s ^ (s >>> 15), 1 | s)
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <T>(items: readonly T[], seed: number): T[] => {
  const next = random(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const kept = out[i] as T
    out[i] = out[j] as T
    out[j] = kept
  }
  return out
}

/** What the host renders and inspects at t. */
type Probe = {
  /** The host's final, composited pixels. */
  render: (t: number) => Promise<Uint8Array | Uint8ClampedArray>
  inspect?: (t: number) => Promise<Json>
}

/** One visit to t: its pixel hash and its inspect JSON. */
export type Visit = { hash: string; json?: Json }

/**
 * Visits each t of `first` again, in a seeded shuffled order that is never the first order, and
 * reports each t whose pixel hash or inspect JSON changed. `after` is the t visited just before.
 */
export const revisit = async (
  first: ReadonlyMap<number, Visit>,
  o: Probe & { seed?: number },
  after: number | null = null,
): Promise<DeterminismFailure[]> => {
  const times = [...first.keys()]
  let order = shuffle(times, o.seed ?? 1)
  if (times.length >= 2 && order.every((t, i) => t === times[i])) order = order.reverse()
  const failures: DeterminismFailure[] = []
  for (const t of order) {
    const was = first.get(t) as Visit
    const hash = await sha256(await o.render(t))
    if (hash !== was.hash)
      failures.push({ kind: 'pixels', t, after, first: was.hash, second: hash })
    if (o.inspect) {
      const changes = diffJson(was.json as Json, await o.inspect(t))
      if (changes.length > 0) failures.push({ kind: 'inspect', t, after, changes })
    }
    after = t
  }
  return failures
}

/**
 * Renders every t twice, in ascending order and then shuffled, and reports each t whose pixel
 * hash or inspect JSON differs between the two visits. Each visit renders t, then inspects it.
 */
export const checkDeterminism = async (
  o: Probe & { times: readonly number[]; seed?: number },
): Promise<DeterminismReport> => {
  const times = [...o.times].sort((a, b) => a - b)
  const first = new Map<number, Visit>()
  for (const t of times) {
    const hash = await sha256(await o.render(t))
    first.set(t, { hash, json: o.inspect ? await o.inspect(t) : undefined })
  }
  return { times, failures: await revisit(first, o) }
}

/** `count` of the items: the first, the last and seeded picks between, in their order. */
export const samples = <T>(items: readonly T[], count: number, seed = 1): T[] => {
  const n = Math.min(count, items.length)
  if (n <= 0) return []
  const middle = Array.from({ length: Math.max(0, items.length - 2) }, (_, i) => i + 1)
  const picked = new Set([0, items.length - 1, ...shuffle(middle, seed)].slice(0, n))
  return [...picked].sort((a, b) => a - b).map((i) => items[i] as T)
}

/** Frame-aligned times to check: frame 0, the last frame, and seeded picks between, ascending. */
export const sampleTimes = (fps: number, duration: number, count: number, seed = 1): number[] =>
  samples(frameTimes(fps, 0, duration), count, seed)
