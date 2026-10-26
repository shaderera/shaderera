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
  /** The final, composited pixels of host `host` (0 when there is one). */
  render: (t: number, host: number) => Promise<Uint8Array | Uint8ClampedArray>
  inspect?: (t: number) => Promise<Json>
}

/** One visit to t: its pixel hash and its inspect JSON. */
export type Visit = { hash: string; json?: Json }

/**
 * Visits each t of `first` again, in a seeded shuffled order, and reports each t whose pixel hash
 * or inspect JSON changed. With several `hosts` the visits are split between them and run at
 * once, evenly: a t is visited again on a host other than the one that first visited it (its
 * `host`, 0 when not given), so the hosts must agree with each other too. Each host's share
 * keeps the shuffled order, never its ascending one. `after[h]` is the t host h visited just
 * before (null when not given); a failure names the t visited before it on the same host.
 * `onVisit` is called after each visit with how many are done and the total.
 */
export const revisit = async (
  first: ReadonlyMap<number, Visit & { host?: number }>,
  o: Probe & {
    seed?: number
    hosts?: number
    signal?: AbortSignal
    onVisit?: (done: number, total: number) => void
  },
  after: readonly (number | null)[] = [],
): Promise<DeterminismFailure[]> => {
  const hosts = Math.max(1, Math.floor(o.hosts ?? 1))
  const order = shuffle([...first.keys()], o.seed ?? 1)
  // Each t, in that order, to the host with the fewest so far that did not visit it first.
  const shares: number[][] = Array.from({ length: hosts }, () => [])
  for (const t of order) {
    const was = first.get(t)?.host ?? 0
    let to = hosts > 1 && was === 0 ? 1 : 0
    for (let h = 0; h < hosts; h++)
      if (h !== was && (shares[h] as number[]).length < (shares[to] as number[]).length) to = h
    ;(shares[to] as number[]).push(t)
  }
  for (const [h, share] of shares.entries())
    if (share.length >= 2 && share.every((t, i) => i === 0 || (share[i - 1] as number) < t))
      shares[h] = share.reverse()
  let done = 0
  // One host failing stops the others at their next visit.
  let stopped = false
  const visit = async (host: number, share: readonly number[]) => {
    const failures: DeterminismFailure[] = []
    let before = after[host] ?? null
    for (const t of share) {
      if (stopped) break
      o.signal?.throwIfAborted()
      const was = first.get(t) as Visit
      const hash = await sha256(await o.render(t, host))
      if (hash !== was.hash)
        failures.push({ kind: 'pixels', t, after: before, first: was.hash, second: hash })
      if (o.inspect) {
        const changes = diffJson(was.json as Json, await o.inspect(t))
        if (changes.length > 0) failures.push({ kind: 'inspect', t, after: before, changes })
      }
      before = t
      o.onVisit?.(++done, first.size)
    }
    return failures
  }
  try {
    return (await Promise.all(shares.map((share, h) => visit(h, share)))).flat()
  } finally {
    stopped = true
  }
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
    const hash = await sha256(await o.render(t, 0))
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
