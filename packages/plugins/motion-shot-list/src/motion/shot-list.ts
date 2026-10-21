/**
 * A film's shots in order, and which of them are on screen at t: each shot's local time and
 * progress, the transition's progress while the shot before is still showing, and the source time
 * and source frame for footage. Plain data in and out; it draws nothing, so how a transition looks
 * is the film's code.
 */

export type Shot = {
  id: string
  /** Seconds on screen, the transition out of it (the next shot's `transition`) included. */
  dur: number
  /**
   * Seconds of transition into this shot: the shot before stays on screen this long after the cut.
   * 0, a hard cut, by default.
   */
  transition?: number
  /** The footage it shows, for `closeAt`. */
  src?: string
  /** The source's rate, to get `frame`: a number (`clip.fps`) or a fraction `"24000/1001"`. */
  fps?: number | string
  /** Source seconds at the cut. 0 by default. */
  in?: number
  /** Source seconds per film second: 2 is twice as fast, -1 plays backwards from `in`. 1 by default. */
  speed?: number
  /** Seconds at the shot's end that freeze on the picture reached when they start. */
  hold?: number
}

/** A shot placed in the film: its index and when it is on screen, from `start` up to `end`. */
export type Placed = Shot & { index: number; start: number; end: number }

export type ShotList = {
  shots: Placed[]
  /** Where the last shot ends. */
  duration: number
  /** For each `src`, the time after which no shot shows it: its footage may be `close()`d then. */
  closeAt: Record<string, number>
}

/** A shot at t. */
export type OnScreen = {
  shot: Placed
  /** Seconds since its cut. */
  local: number
  /** `local / dur`, 0 to 1. */
  progress: number
  /** Seconds into its source: `in + speed × local`, frozen through `hold`. */
  source: number
  /** The source frame showing, when the shot has an `fps`: floored, never below 0. */
  frame?: number
}

export type At = {
  /** The shot cut to last. */
  shot: OnScreen
  /** The shot before, while the transition into `shot` runs. */
  leaving?: OnScreen
  /** The transition's progress, 0 at the cut to 1 when `leaving` is gone; 1 when there is none. */
  transition: number
}

/** The shots one after another, each starting its `transition` before the one before it ends. */
export const shotList = (shots: readonly Shot[]): ShotList => {
  const placed: Placed[] = []
  const closeAt: Record<string, number> = {}
  let start = 0
  for (const [index, shot] of shots.entries()) {
    const fail = (why: string) => {
      throw new Error(`Shot ${index} "${shot.id}": ${why}`)
    }
    const transition = shot.transition ?? 0
    const before = placed[index - 1]
    if (!(shot.dur > 0)) fail(`dur must be above 0, not ${shot.dur}`)
    if (!(transition >= 0)) fail(`transition must be 0 or more, not ${transition}`)
    if (transition > 0 && !before) fail('the first shot has no shot before it to transition from')
    if (before && transition > Math.min(before.dur, shot.dur))
      fail(`its transition (${transition} s) is longer than it or the shot before`)
    if (shot.hold !== undefined && !(shot.hold >= 0 && shot.hold <= shot.dur))
      fail(`hold must be from 0 to dur, not ${shot.hold}`)
    if (shot.fps !== undefined) rate(shot.fps, fail)
    if (before) start = before.end - transition
    const twoBack = placed[index - 2]
    if (twoBack && start < twoBack.end - 1e-9)
      fail(`it starts before "${twoBack.id}" ends: only two shots may be on screen at once`)
    const p = { ...shot, index, start, end: start + shot.dur }
    placed.push(p)
    if (shot.src !== undefined) closeAt[shot.src] = Math.max(closeAt[shot.src] ?? 0, p.end)
  }
  return { shots: placed, duration: placed.at(-1)?.end ?? 0, closeAt }
}

/** What is on screen at t. Before 0 it is the first shot, after the end the last. */
export const shotAt = (list: ShotList, t: number): At => {
  const { shots } = list
  if (!shots.length) throw new Error('shotAt: the shot list is empty')
  // The last shot that has started by t.
  let lo = 0
  let hi = shots.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (shots[mid]!.start <= t) lo = mid
    else hi = mid - 1
  }
  const shot = shots[lo]!
  const before = shots[lo - 1]
  if (!before || t >= before.end) return { shot: onScreen(shot, t), transition: 1 }
  return {
    shot: onScreen(shot, t),
    leaving: onScreen(before, t),
    transition: (t - shot.start) / (before.end - shot.start),
  }
}

const onScreen = (shot: Placed, t: number): OnScreen => {
  const local = t - shot.start
  const speed = shot.speed ?? 1
  const moving = Math.min(local, shot.dur - (shot.hold ?? 0))
  const source = (shot.in ?? 0) + speed * moving
  const on: OnScreen = {
    shot,
    local,
    progress: Math.min(1, Math.max(0, local / shot.dur)),
    source,
  }
  if (shot.fps !== undefined) {
    const [num, den] = rate(shot.fps)
    // Exact for NTSC: the rate as its fraction, and a nudge far below a frame for float error.
    const x = (source * num) / den
    // Backwards, a frame shows from its end to its start: the one before `in` shows first.
    const f = speed < 0 ? Math.ceil(x - 1e-6) - 1 : Math.floor(x + 1e-6)
    on.frame = Math.max(0, f)
  }
  return on
}

/** NTSC rates written as decimals are these nominal × 1000/1001 (23.976, 29.97, 59.94…). */
const NTSC = [24, 30, 48, 60, 120]

/** A rate as an exact fraction [num, den], as core's parseFps reads shaderera.json's fps. */
const rate = (
  fps: number | string,
  fail = (why: string): never => {
    throw new Error(why)
  },
): [number, number] => {
  if (typeof fps === 'string') {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(fps)
    if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return [Number(m[1]), Number(m[2])]
  } else if (Number.isFinite(fps) && fps > 0) {
    const ntsc = NTSC.find((n) => Math.abs(fps - (n * 1000) / 1001) < 0.005)
    if (ntsc !== undefined) return [ntsc * 1000, 1001]
    return Number.isInteger(fps) ? [fps, 1] : [Math.round(fps * 1000), 1000]
  }
  return fail(`fps must be a positive number or a fraction such as "24000/1001", not ${fps}`)
}
