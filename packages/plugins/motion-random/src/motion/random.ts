// Deterministic random numbers from a seed: a hash of an integer, the same whenever it is asked
// (random.wgsl.ts gives the same hash in a shader), and a seeded stream for a run of numbers made
// once, in open. Never Math.random, so a frame renders the same every time.

/** A 32-bit hash of an integer (PCG): v is cut to 32 bits first, so -1 hashes as 0xffffffff. */
export const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}

/** A hash as a number in [0, 1). */
export const rnd = (v: number) => hash(v) / 4294967296

/** A seeded stream of numbers in [0, 1) (mulberry32): the same run for the same seed. */
export const stream = (seed: number) => {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
