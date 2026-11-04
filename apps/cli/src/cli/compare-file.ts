// `still --compare-file`: the film measured against a reference clip, frame by frame and over
// time. It measures and never judges (decisions 0011 and 0032): there is no pass or fail.
import type { VideoColour } from '@shaderera/core'
import { packetTimes } from '../node/services.ts'
import { compareFrames } from '../review/compare.ts'
import {
  align,
  difference,
  FILTER,
  meanChange,
  motionWindow,
  row,
  type Score,
  scaleFrame,
  stepOf,
} from '../review/reference.ts'
import { insideFilm } from './args.ts'
import { crop, type Region } from './crop.ts'
import { openFile } from './video-file.ts'

/** The film's side: its frame size and length, and its final frame at t. */
export type FilmSide = {
  width: number
  height: number
  duration: number
  render: (t: number) => Promise<Uint8Array>
}

export type CompareFileOptions = {
  /** The reference clip's path. */
  reference: string
  film: FilmSide
  /** The times asked for, in seconds on the film; none for the reference's frames over from–to. */
  times: readonly number[]
  /** With no times: the first time (the first the reference has, at or after 0). */
  from?: number
  /** With no times: before this time (the end of whichever side ends first). */
  to?: number
  /** Seconds: the reference is read at t + offset. */
  offset?: number
  /** How many steps either way the alignment searches; one second's by default. */
  maxShift?: number
  /** At most this many times are measured, or it throws before rendering any; none by default. */
  limit?: number
  /** Frame pixels of the film: only this part is measured and shown. */
  region?: Region
  /** The change (levels) a motion window counts as still; 0 by default. */
  floor?: number
  /** Each time's film, reference and difference side by side, as it is measured. */
  frame?: (f: {
    index: number
    count: number
    t: number
    pixels: Uint8Array
    width: number
    height: number
  }) => Promise<void>
}

/** A motion window on the film's timeline, in seconds. */
export type TimedWindow = { first: number; last: number; peak: { t: number; change: number } }

export type CompareFileReport = {
  reference: {
    file: string
    width: number
    height: number
    fps: number
    duration: number
    /** Its sample depth and its planes' colour, as the decoder read them (probeVideo). */
    bits: number
    colour: VideoColour
    /**
     * How a frame's time was found: `constant`, frame i at i / fps, checked against every frame's
     * time in the file (a clip whose frames are not is refused). Another may be added.
     */
    timing: 'constant'
  }
  /** How the reference was scaled to the film's frame, or `null` when the sizes are the same. */
  scaled: {
    from: [number, number]
    to: [number, number]
    filter: string
    /** `stretched` when the two frames have other shapes. */
    aspect: 'same' | 'stretched'
  } | null
  region: Region | null
  /** Seconds between the times, when they are evenly spaced; `null` when not. */
  step: number | null
  floor: number
  offset: {
    /** Seconds: the reference was read at t + applied. */
    applied: number
    /** The shift that best aligns the activity curves; `null` with `why` when none could be. */
    found: { steps: number; seconds: number; correlation: number } | null
    why?: string
    maxShift: number
    scores: Score[]
  }
  window: { film: TimedWindow | null; reference: TimedWindow | null }
  frames: {
    t: number
    /** The reference's time asked for t: t + offset. */
    at: number
    /** The reference's frame read for it: the last whose time is at or before `at`. */
    frame: number
    ms: number
    psnr: number
    deltaE: number
    maxDeltaE: number
    differing: number
    /** meanChange from the time before, in levels; `null` at the first. */
    activity: { film: number | null; reference: number | null }
  }[]
}

const round6 = (t: number) => Number(t.toFixed(6))

/**
 * With no times: from `from` up to before `to` at the reference's rate, from + i / fps unrounded.
 * Only the report rounds them, to 6 decimals.
 */
export const rateTimes = (from: number, to: number, fps: number): number[] => {
  const times: number[] = []
  for (let i = 0; from + i / fps < to - 1e-9; i++) times.push(from + i / fps)
  return times
}

/**
 * The reference frame read at t: the last whose time is at or before t, where a time up to
 * 10 µs before a frame's is that frame's. Times and offsets are written to 6 decimals, and 1/30 s
 * written 0.033333 falls just before frame 1; 10 µs is far less than any clip's frame time.
 */
export const referenceFrame = (t: number, fps: number): number => Math.floor((t + 1e-5) * fps)

/**
 * Why a clip's frames are not at i / fps, or undefined when each is within half a frame of it.
 * `times` are its frames' times, ascending (packetTimes); `null` for a frame without one.
 */
export const varyingRate = (times: readonly (number | null)[], fps: number): string | undefined => {
  const first = times[0]
  if (first === undefined || first === null) return times.length ? 'frame 0 has no time' : undefined
  for (let i = 1; i < times.length; i++) {
    const t = times[i]
    if (t === null || t === undefined) return `frame ${i} has no time`
    const want = i / fps
    if (Math.abs(t - first - want) > 0.5 / fps)
      return `frame ${i} at ${round6(t - first)} s, not ${round6(want)} s at ${round6(fps)} fps`
  }
  return undefined
}

/** The most rows of a compare-file sheet. */
export const SHEET_ROWS = 64

/**
 * Whether time `index` of `count` is on a sheet of at most `most` rows: every one when they fit,
 * else `most` spread evenly from the first to the last.
 */
export const onSheet = (index: number, count: number, most = SHEET_ROWS): boolean =>
  count <= most ||
  Array.from({ length: most }, (_, k) => Math.round((k * (count - 1)) / (most - 1))).includes(index)

/** Measures the film against a reference clip (see CompareFileOptions); throws on bad input. */
export const compareWithFile = async (o: CompareFileOptions): Promise<CompareFileReport> => {
  const offset = o.offset ?? 0
  if (!Number.isFinite(offset)) throw new Error(`--offset is seconds, not ${o.offset}.`)
  const floor = o.floor ?? 0
  if (!(Number.isFinite(floor) && floor >= 0))
    throw new Error(`--floor is a change in levels, 0 or more, not ${o.floor}.`)
  const ref = openFile(o.reference)
  try {
    const { film } = o
    if (ref.frames === 1)
      throw new Error(
        // #665: measuring against a still.
        `${o.reference} is one frame: measuring against a still is not built yet. --compare-file takes a clip.`,
      )
    // Frame i is read as the frame at i / fps: a clip whose frames are not is refused.
    const varying = varyingRate(packetTimes(o.reference), ref.fps)
    if (varying)
      throw new Error(
        `${o.reference} has a variable frame rate (${varying}): --compare-file reads a clip of constant rate; re-encode it with -fps_mode cfr first.`,
      )
    const frameOf = (t: number) => referenceFrame(t + offset, ref.fps)
    const ends = (t: number) => frameOf(t) >= 0 && frameOf(t) < ref.frames
    let times: number[]
    if (o.times.length === 0) {
      const from = o.from ?? Math.max(0, -offset)
      const to = o.to ?? Math.min(film.duration, ref.duration - offset)
      if (!(to > from))
        throw new Error(
          `Nothing to compare: from ${from} s to ${to} s, with the reference ${ref.duration} s long read at t + ${offset} s.`,
        )
      times = rateTimes(from, to, ref.fps)
    } else {
      if (o.from !== undefined || o.to !== undefined)
        throw new Error(
          '--from and --to without --count set the span of the reference frames: give no times with them.',
        )
      times = [...new Set(o.times)].sort((a, b) => a - b)
    }
    insideFilm(times, film.duration)
    if (o.limit !== undefined && times.length > o.limit)
      throw new Error(
        `${times.length} times to render and measure: at most ${o.limit} at once. Give a shorter from–to, fewer times or a longer every.`,
      )
    const missing = times.filter((t) => !ends(t))
    if (missing.length > 0)
      throw new Error(
        `The reference (${ref.duration} s) has no frame at t + ${offset} s for: ${missing.map(round6).join(', ')}.`,
      )
    const step = stepOf(times)
    let maxShift = 0
    let why: string | undefined
    if (step === null) {
      if (o.maxShift !== undefined)
        throw new Error('--max-shift searches evenly spaced times: these are not.')
      why = times.length < 2 ? 'one time has no activity' : 'the times are not evenly spaced'
    } else {
      maxShift = o.maxShift ?? Math.round(1 / step)
      if (!(Number.isInteger(maxShift) && maxShift >= 0))
        throw new Error(`--max-shift is a whole number of steps, 0 or more, not ${o.maxShift}.`)
    }
    // The reference is also read up to maxShift steps before the first time and after the last,
    // where it has frames, so every shift is measured over all the film's times.
    const before: number[] = []
    const after: number[] = []
    if (step !== null)
      for (let k = 1; k <= maxShift; k++) {
        const early = (times[0] as number) - k * step
        const late = (times.at(-1) as number) + k * step
        if (ends(early)) before.unshift(early)
        if (ends(late)) after.push(late)
      }
    const lead = before.length
    const readAt = [...before, ...times, ...after]

    const { width, height } = film
    const scaled =
      ref.width === width && ref.height === height
        ? null
        : {
            from: [ref.width, ref.height] as [number, number],
            to: [width, height] as [number, number],
            filter: FILTER,
            aspect:
              Math.abs(ref.width * height - ref.height * width) <= 0.005 * ref.height * width
                ? ('same' as const)
                : ('stretched' as const),
          }
    const part = (px: Uint8Array) => (o.region ? crop(px, film, o.region) : undefined)
    const region = o.region
      ? (part(new Uint8Array(width * height * 4)) as { region: Region }).region
      : null
    const shown = region ?? { x: 0, y: 0, width, height }

    const refCurve: (number | null)[] = []
    const filmCurve: (number | null)[] = []
    const frames: CompareFileReport['frames'] = []
    let refPrev: Uint8Array | undefined
    let filmPrev: Uint8Array | undefined
    for (let j = 0; j < readAt.length; j++) {
      const t = readAt[j] as number
      const read = await ref.index(frameOf(t))
      const whole = scaleFrame(read, ref.width, ref.height, width, height)
      const theirs = part(whole)?.pixels ?? whole
      refCurve.push(refPrev ? meanChange(refPrev, theirs) : null)
      refPrev = theirs
      const i = j - lead
      if (i < 0 || i >= times.length) continue
      const started = performance.now()
      const rendered = await film.render(t)
      const ms = performance.now() - started
      const ours = part(rendered)?.pixels ?? rendered
      filmCurve.push(filmPrev ? meanChange(filmPrev, ours) : null)
      filmPrev = ours
      frames.push({
        t: round6(t),
        at: round6(t + offset),
        frame: frameOf(t),
        ms,
        ...compareFrames(ours, theirs),
        activity: {
          film: filmCurve[i] as number | null,
          reference: i === 0 ? null : (refCurve[j] as number),
        },
      })
      await o.frame?.({
        index: i,
        count: times.length,
        t: round6(t),
        pixels: row([ours, theirs, difference(ours, theirs)], shown.width, shown.height),
        width: shown.width * 3,
        height: shown.height,
      })
    }

    const inRange = refCurve.slice(lead, lead + times.length).map((c, i) => (i === 0 ? null : c))
    const timed = (w: ReturnType<typeof motionWindow>): TimedWindow | null =>
      w && {
        first: round6(times[w.first] as number),
        last: round6(times[w.last] as number),
        peak: { t: round6(times[w.peak.index] as number), change: w.peak.change },
      }
    const a = step === null ? undefined : align(filmCurve, refCurve, maxShift, lead)
    if (a && a.shift === null) why = 'a curve does not change over enough of the times to correlate'
    return {
      reference: {
        file: o.reference,
        width: ref.width,
        height: ref.height,
        fps: ref.fps,
        duration: ref.duration,
        bits: ref.bits,
        colour: ref.colour,
        timing: 'constant',
      },
      scaled,
      region,
      step: step === null ? null : round6(step),
      floor,
      offset: {
        applied: offset,
        found:
          a && a.shift !== null
            ? {
                steps: a.shift,
                seconds: round6(a.shift * (step as number)),
                correlation: a.correlation as number,
              }
            : null,
        ...(why && !(a && a.shift !== null) ? { why } : {}),
        maxShift,
        scores: a?.scores ?? [],
      },
      window: {
        film: timed(motionWindow(filmCurve, floor)),
        reference: timed(motionWindow(inRange, floor)),
      },
      frames,
    }
  } finally {
    await ref.close()
  }
}

/** The report as lines: the reference, then the offset and each side's motion window. */
export const summaryLines = (r: CompareFileReport): string[] => {
  const n = (x: number) => Number(x.toFixed(3))
  const ref = r.reference
  const lines = [
    `reference: ${ref.width}×${ref.height} at ${n(ref.fps)} fps, ${n(ref.duration)} s${
      r.scaled
        ? `, scaled to ${r.scaled.to.join('×')} (${r.scaled.filter}${r.scaled.aspect === 'stretched' ? ', stretched: the frames have other shapes' : ''})`
        : ''
    }${r.region ? `; measured in ${r.region.width}×${r.region.height} at ${r.region.x},${r.region.y}` : ''}`,
  ]
  const win = (w: TimedWindow | null) =>
    w
      ? `moves ${w.first.toFixed(3)}–${w.last.toFixed(3)} s, peak ${w.peak.t.toFixed(3)} s (${w.peak.change.toFixed(2)})`
      : 'still'
  lines.push(
    `film ${win(r.window.film)}; reference ${win(r.window.reference)}${r.floor > 0 ? ` (above ${r.floor})` : ''}`,
  )
  const o = r.offset
  const unit = r.step === null ? '' : ` steps of ${n(r.step)} s`
  if (o.found) {
    // `--offset=` so that a negative one reads as a value, not as a flag.
    const total = round6(o.applied + o.found.seconds)
    lines.push(
      `offset: applied ${n(o.applied)} s; the curves align best at ${o.found.steps > 0 ? '+' : ''}${o.found.steps}${unit} (${n(o.found.seconds)} s, correlation ${o.found.correlation.toFixed(3)}), searched ±${o.maxShift}${
        o.found.steps === 0 ? '' : `. Aligned: --offset=${total}`
      }`,
    )
  } else lines.push(`offset: applied ${n(o.applied)} s; no alignment: ${o.why}`)
  return lines
}

/** One time's line: the measurements between the film and the reference. */
export const frameLine = (f: CompareFileReport['frames'][number]) => {
  const psnr = Number.isFinite(f.psnr) ? `PSNR ${f.psnr.toFixed(2)} dB` : 'identical'
  const change = (c: number | null) => (c === null ? '–' : c.toFixed(2))
  return `${f.ms.toFixed(0)} ms  ${psnr}, mean ΔE ${f.deltaE.toFixed(3)} (max ${f.maxDeltaE.toFixed(2)}), ${f.differing} pixels differ; change ${change(f.activity.film)} vs ${change(f.activity.reference)}`
}
