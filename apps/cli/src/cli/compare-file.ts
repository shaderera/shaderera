// `still --compare-file`: the film measured against a reference clip, frame by frame (PSNR, ΔE,
// SSIM, the edge score, each region's) and over time, or against a still image (compare-image.ts). It measures and never judges (decisions 0011
// and 0032): there is no pass or fail.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import type { VideoColour } from '@shaderera/core'
import { packetTimes } from '../node/services.ts'
import { compareFrames } from '../review/compare.ts'
import {
  align,
  difference,
  meanChange,
  motionWindow,
  row,
  type Score,
  stepOf,
} from '../review/reference.ts'
import { heatMap } from '../review/structure.ts'
import { insideFilm } from './args.ts'
import {
  type CompareImageReport,
  compareWithImage,
  fitText,
  isImage,
  METHOD,
  placement,
  type Structure,
  structure,
  structureLines,
} from './compare-image.ts'
import type { Region } from './crop.ts'
import { openFile } from './video-file.ts'

/** The film's side: its frame size and length, and its final frame at t. */
export type FilmSide = {
  width: number
  height: number
  duration: number
  render: (t: number) => Promise<Uint8Array>
}

/** One time's film, reference and difference (or heat map) side by side, as it is measured. */
export type ShownFrame = {
  index: number
  count: number
  t: number
  pixels: Uint8Array
  width: number
  height: number
}

export type CompareFileOptions = {
  /** The reference's path: a clip, or a PNG or JPEG (compareWithImage). */
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
  /** A regions file whose regions are scored apart (compare-image.ts placement). */
  regions?: string
  /**
   * With a reference of another shape than the film's frame: how it is fitted to the frame, which
   * the person chooses (an image of another shape is refused without it, a clip is stretched):
   * stretch, contain or cover.
   */
  fit?: string
  /** With a clip: each time shows the SSIM heat map in place of the difference (an image's does). */
  heatMap?: boolean
  /** A project's root that every file the regions file names must be in (MCP: inside). */
  within?: string
  /** Each time's film, reference and difference side by side, as it is measured. */
  frame?: (f: ShownFrame) => Promise<void>
}

/** A motion window on the film's timeline, in seconds. */
export type TimedWindow = { first: number; last: number; peak: { t: number; change: number } }

export type CompareFileReport = {
  reference: {
    kind: 'clip'
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
     * time in the file; `variable` when a frame is more than half a frame from that, each frame
     * at its own packet time from the first's, held until the next (sample and hold).
     */
    timing: 'constant' | 'variable'
    /** With `variable`: the smallest and largest time between two frames, in seconds. */
    intervals?: { smallest: number; largest: number }
  }
  /**
   * How the reference was scaled to the film's frame, or `null` when the sizes are the same; with
   * a fit, as an image's (CompareImageReport).
   */
  scaled: CompareImageReport['scaled']
  region: Region | null
  method: CompareImageReport['method']
  regions: CompareImageReport['regions']
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
  frames: ({
    t: number
    /** The reference's time asked for t: t + offset. */
    at: number
    /** The reference's frame read for it: the last whose time is at or before `at`. */
    frame: number
    /** That frame's time on the reference, in seconds from its first frame. */
    read: number
    ms: number
    psnr: number
    deltaE: number
    maxDeltaE: number
    differing: number
    /** meanChange from the time before, in levels; `null` at the first. */
    activity: { film: number | null; reference: number | null }
  } & Structure)[]
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

/**
 * The frame read at t from frames at `times` (ascending, from the first at 0): the last whose
 * time is at or before t, with referenceFrame's 10 µs; -1 before the first.
 */
export const frameAt = (t: number, times: readonly number[]): number => {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] as number) <= t + 1e-5) lo = mid + 1
    else hi = mid
  }
  return lo - 1
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

/**
 * Measures the film against a reference (see CompareFileOptions): a clip over time, or a PNG or
 * JPEG still at each time asked for (compareWithImage). Throws on bad input.
 */
export const compareWithFile = async (
  o: CompareFileOptions,
): Promise<CompareFileReport | CompareImageReport> => {
  if (isImage(o.reference)) return compareWithImage(o)
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
        `${o.reference} is a clip of one frame: to measure against it as a still, save it as a PNG once.`,
      )
    // Frame i is read as the frame at i / fps, or, when its frames are not, at its own time.
    const packets = packetTimes(o.reference)
    const varying = varyingRate(packets.times, ref.fps) !== undefined
    const missingTime = packets.times.indexOf(null)
    if (missingTime >= 0)
      throw new Error(
        `${o.reference} has a frame without a time (frame ${missingTime}): --compare-file cannot place it.`,
      )
    const first = (packets.times[0] ?? 0) as number
    const own = (packets.times as number[]).map((t) => t - first)
    // A variable clip ends when its last packet does; one whose packets have no durations, at its
    // last frame, which is then read only at its own time.
    const duration = varying
      ? packets.length === null
        ? (own.at(-1) as number)
        : packets.length
      : ref.duration
    const frameOf = varying
      ? (t: number) => frameAt(t + offset, own)
      : (t: number) => referenceFrame(t + offset, ref.fps)
    const ends = varying
      ? (t: number) =>
          frameOf(t) >= 0 && t + offset < Math.max(duration, (own.at(-1) as number) + 1e-5)
      : (t: number) => frameOf(t) >= 0 && frameOf(t) < ref.frames
    const timeOf = (i: number) => (varying ? (own[i] as number) : i / ref.fps)
    let times: number[]
    if (o.times.length === 0) {
      const from = o.from ?? Math.max(0, -offset)
      const to = o.to ?? Math.min(film.duration, duration - offset)
      if (!(to > from))
        throw new Error(
          `Nothing to compare: from ${from} s to ${to} s, with the reference ${duration} s long read at t + ${offset} s.`,
        )
      // A variable clip's own frames: each at its time, read at t + offset.
      times = varying
        ? own.map((t) => t - offset).filter((t) => t >= from - 1e-9 && t < to - 1e-9)
        : rateTimes(from, to, ref.fps)
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
        `The reference (${duration} s) has no frame at t + ${offset} s for: ${missing.map(round6).join(', ')}.`,
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

    const p = placement(o, ref, () => sha256Of(o.reference), 'clip')
    const { width: w, height: h } = p.shown

    const refCurve: (number | null)[] = []
    const filmCurve: (number | null)[] = []
    const frames: CompareFileReport['frames'] = []
    let refPrev: Uint8Array | undefined
    let filmPrev: Uint8Array | undefined
    for (let j = 0; j < readAt.length; j++) {
      const t = readAt[j] as number
      const read = await ref.index(frameOf(t))
      const theirs = p.part(p.place(read))
      refCurve.push(refPrev ? meanChange(refPrev, theirs) : null)
      refPrev = theirs
      const i = j - lead
      if (i < 0 || i >= times.length) continue
      const started = performance.now()
      const rendered = await film.render(t)
      const ms = performance.now() - started
      const ours = p.part(rendered)
      filmCurve.push(filmPrev ? meanChange(filmPrev, ours) : null)
      filmPrev = ours
      const { map, ...measured } = structure(ours, theirs, w, h, p.found, p.shown)
      frames.push({
        t: round6(t),
        at: round6(t + offset),
        frame: frameOf(t),
        read: round6(timeOf(frameOf(t))),
        ms,
        ...compareFrames(ours, theirs),
        ...measured,
        activity: {
          film: filmCurve[i] as number | null,
          reference: i === 0 ? null : (refCurve[j] as number),
        },
      })
      await o.frame?.({
        index: i,
        count: times.length,
        t: round6(t),
        pixels: row([ours, theirs, o.heatMap ? heatMap(map) : difference(ours, theirs)], w, h),
        width: w * 3,
        height: h,
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
        kind: 'clip',
        file: o.reference,
        width: ref.width,
        height: ref.height,
        fps: ref.fps,
        duration: varying ? round6(duration) : ref.duration,
        bits: ref.bits,
        colour: ref.colour,
        timing: varying ? 'variable' : 'constant',
        ...(varying ? { intervals: intervals(own) } : {}),
      },
      scaled: p.scaled,
      region: p.region,
      method: METHOD,
      regions: p.regions,
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

/** A file's sha256, read in chunks: a clip can be large. */
const sha256Of = (path: string): string => {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.alloc(1 << 20)
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk))
      hash.update(chunk.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** The smallest and largest time between two frames at `times` (ascending), in seconds. */
const intervals = (times: readonly number[]) => {
  let smallest = Number.POSITIVE_INFINITY
  let largest = 0
  for (let i = 1; i < times.length; i++) {
    const d = (times[i] as number) - (times[i - 1] as number)
    smallest = Math.min(smallest, d)
    largest = Math.max(largest, d)
  }
  return { smallest: round6(smallest), largest: round6(largest) }
}

/** The report as lines: the reference, then the offset and each side's motion window. */
export const summaryLines = (r: CompareFileReport): string[] => {
  const n = (x: number) => Number(x.toFixed(3))
  const ref = r.reference
  const lines = [
    `reference: ${ref.width}×${ref.height} at ${ref.intervals ? `a variable rate (frames ${n(ref.intervals.smallest)}–${n(ref.intervals.largest)} s apart)` : `${n(ref.fps)} fps`}, ${n(ref.duration)} s${
      r.scaled
        ? `, scaled to ${r.scaled.to.join('×')} (${r.scaled.filter}${r.scaled.fit !== undefined ? fitText(r.scaled) : r.scaled.aspect === 'stretched' ? ', stretched: the frames have other shapes' : ''})`
        : ''
    }${r.region ? `; measured in ${r.region.width}×${r.region.height} at ${r.region.x},${r.region.y}` : ''}`,
  ]
  if (r.regions)
    lines.push(
      `regions: ${r.regions.list.map((q) => q.id).join(', ')} (${r.regions.kind} in ${r.regions.in.join('×')})`,
    )
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

/** One time's lines: the measurements between the film and the reference, then each region's. */
export const frameLines = (f: CompareFileReport['frames'][number]): string[] => {
  const psnr = Number.isFinite(f.psnr) ? `PSNR ${f.psnr.toFixed(2)} dB` : 'identical'
  const change = (c: number | null) => (c === null ? '–' : c.toFixed(2))
  const [whole, ...regions] = structureLines(f)
  return [
    `${f.ms.toFixed(0)} ms  ${psnr}, mean ΔE ${f.deltaE.toFixed(3)} (max ${f.maxDeltaE.toFixed(2)}), ${f.differing} pixels differ; ${whole}; change ${change(f.activity.film)} vs ${change(f.activity.reference)}`,
    ...regions,
  ]
}
