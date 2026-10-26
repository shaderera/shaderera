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
  /** The inspect JSON of host `host` at t. */
  inspect?: (t: number, host: number) => Promise<Json>
}

/** One visit to t: its pixel hash and its inspect JSON. */
export type Visit = { hash: string; json?: Json }

/**
 * Visits each t of `first` again, in a seeded shuffled order, and reports each t whose pixel hash
 * or inspect JSON changed. With several `hosts` the visits are split between them and run at
 * once, evenly: a t is visited again on a host other than the one that first visited it (its
 * `host`, 0 when not given) where one has room, so the hosts must agree with each other too
 * (with 2 hosts at an even fps every t may have been host 0's: host 0 then takes back half).
 * Each host's share keeps the shuffled order, never its ascending one, and each visit renders
 * then inspects on that host. `after[h]` is the t host h visited just before (null when not
 * given); a failure names the t visited before it on the same host. The first visit that
 * changed stops every host: what they are rendering is dropped, and nothing more is visited,
 * inspected or counted. `onVisit` is called after each visit with how many are done and the
 * total.
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
  // Each t, in that order, to the host with the fewest so far that did not visit it first, while
  // one has fewer than its even share; else to the host that did.
  const shares: number[][] = Array.from({ length: hosts }, () => [])
  const room = Math.ceil(first.size / hosts)
  for (const t of order) {
    const was = first.get(t)?.host ?? 0
    let to = -1
    for (let h = 0; h < hosts; h++) {
      const n = (shares[h] as number[]).length
      if (h !== was && n < room && (to < 0 || n < (shares[to] as number[]).length)) to = h
    }
    ;(shares[to < 0 ? was % hosts : to] as number[]).push(t)
  }
  for (const [h, share] of shares.entries())
    if (share.length >= 2 && share.every((t, i) => i === 0 || (share[i - 1] as number) < t))
      shares[h] = share.reverse()
  let done = 0
  // The first visit that changed, an error or an abort stops every host.
  let stopped = false
  const visit = async (host: number, share: readonly number[]) => {
    const failures: DeterminismFailure[] = []
    let before = after[host] ?? null
    for (const t of share) {
      if (stopped) break
      o.signal?.throwIfAborted()
      const was = first.get(t) as Visit
      const pixels = await o.render(t, host)
      if (stopped) break
      const hash = await sha256(pixels)
      if (hash !== was.hash)
        failures.push({ kind: 'pixels', t, after: before, first: was.hash, second: hash })
      if (o.inspect) {
        const json = await o.inspect(t, host)
        if (stopped) break
        const changes = diffJson(was.json as Json, json)
        if (changes.length > 0) failures.push({ kind: 'inspect', t, after: before, changes })
      }
      if (failures.length > 0) {
        stopped = true
        break
      }
      before = t
      o.onVisit?.(++done, first.size)
    }
    return failures
  }
  try {
    return (await Promise.all(shares.map((share, h) => visit(h, share)))).flat()
  } catch (error) {
    stopped = true
    throw error
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
    first.set(t, { hash, json: o.inspect ? await o.inspect(t, 0) : undefined })
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
