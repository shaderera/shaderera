import { setTimeout as sleep } from 'node:timers/promises'

/** The first retry's wait; each further one waits twice as long. */
export const RETRY_DELAY_MS = 500

/**
 * Runs `attempt`, and again after a transient failure up to `retries` more times, waiting
 * `delayMs` · 2^k before retry k and running `before` (a reopen, say) first. Each retry is logged
 * on stderr with its cause. A failure that is not transient is thrown as it is; after the last
 * retry, the first failure is thrown.
 */
export const withRetries = async <T>(
  attempt: () => Promise<T>,
  o: {
    retries: number
    transient: (error: unknown) => boolean
    /** What failed, for the log: `Frame 12 (t 0.4 s)`, `The encode`. */
    what: string
    /** What a retry does besides trying again, for the log: `reopening its host`. */
    how?: string
    before?: (error: unknown) => Promise<void>
    delayMs?: number
    signal?: AbortSignal
  },
): Promise<T> => {
  let first: unknown
  for (let k = 0; ; k++) {
    try {
      return await attempt()
    } catch (error) {
      if (k === 0) first = error
      if (!o.transient(error) || o.signal?.aborted) throw error
      if (k >= o.retries) throw first
      const ms = (o.delayMs ?? RETRY_DELAY_MS) * 2 ** k
      const cause = error instanceof Error ? error.message : String(error)
      console.warn(
        `! ${o.what} failed: ${cause} Retry ${k + 1}/${o.retries}${o.how ? `, ${o.how},` : ''} in ${ms / 1000} s.`,
      )
      await sleep(ms)
      await o.before?.(error)
    }
  }
}

/** `--retries <n>`: a whole number, 0 (the default) for none. */
export const retriesOf = (value: unknown): number => {
  if (value === undefined) return 0
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`--retries is a whole number, not ${String(value)}.`)
  return n
}
