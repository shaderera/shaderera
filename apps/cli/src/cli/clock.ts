import type { Child, ClockReads } from '../node/child.ts'

/** The wall-clock reads of several hosts, added up. */
export const clockOf = async (hosts: readonly Child[]): Promise<ClockReads> => {
  const all = await Promise.all(hosts.map((h) => h.clock()))
  return all.reduce(
    (a, b) => ({ date: a.date + b.date, performance: a.performance + b.performance }),
    {
      date: 0,
      performance: 0,
    },
  )
}

/**
 * A warning when render read the wall clock (G2, decision 0011), or null: a frame that depends on
 * the clock cannot be rendered again. Counted, never blocked: a library may read it only to log.
 */
export const clockWarning = (c: ClockReads): string | null =>
  c.date + c.performance === 0
    ? null
    : `render read the wall clock ${c.date + c.performance} time(s) (Date: ${c.date}, performance.now: ${c.performance}). A frame that depends on it is not reproducible; time in a frame comes from t (or the frame number). A library that reads it only to log is harmless.`
