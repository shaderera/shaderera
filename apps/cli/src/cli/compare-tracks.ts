// `inspect --compare-tracks`: a film's element tracks measured against reference tracks
// (`shaderera.analysis/1`, kind `reference-tracks`, as docs/analysis.md defines it). It measures
// and never judges (decisions 0011 and 0032): no pass or fail, no threshold. The reader here
// follows docs/analysis.md and imports no plugin.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Json } from '@shaderera/core'
import { inside } from '../node/inside.ts'
import type { DomElement } from '../review/measure.ts'
import { align, type Curve, motionWindow, type Score, stepOf } from '../review/reference.ts'
import type { TimedWindow } from './compare-file.ts'
import { valueAt } from './inspect.ts'

/** One reference track, as docs/analysis.md defines it: one element's one channel. */
type Track = {
  element: string
  channel: string
  unit: string
  samples: [number, number | null][]
}

type Reference = {
  file: string
  source: { path: string; sha256: string } | { url: string }
  frame: { width: number; height: number; pixelRatio: number }
  tracks: Track[]
}

/** What the film is measured by: a value at an inspect path, or a DOM element's channel. */
export type FilmMeasure = { path: string } | { id: string; channel: DomChannel }
const DOM_CHANNELS = ['x', 'y', 'width', 'height', 'opacity'] as const
type DomChannel = (typeof DOM_CHANNELS)[number]

/** A pair the person names: a reference track, and what of the film it is compared with. */
export type Pair = {
  element: string
  channel: string
  film: FilmMeasure
  /** With a px unit and a channel whose axis is not known by its name: which frame side scales it. */
  axis?: 'x' | 'y'
}

/** The film's side: its frame and length, and what it can be measured by. */
export type FilmTracks = {
  width: number
  height: number
  duration: number
  /** The source's inspect(t); none when it has none. */
  inspect?: (t: number) => Promise<Json>
  /** The DOM's elements with a data-id at t; none without a DOM (browser host). */
  elements?: (t: number) => Promise<DomElement[]>
}

export type CompareTracksOptions = {
  /** The reference-tracks file. */
  reference: string
  /** The pairs file: a JSON list of Pair. */
  pairs: string
  /** The project's root: a file source's path is read from it. */
  root: string
  film: FilmTracks
  /** Seconds: the film is measured at each sample's source time minus offset. 0 by default. */
  offset?: number
  /** Steps of the reference's sample interval either way the alignment searches; one second's. */
  maxShift?: number
  /** The change (in the channel's unit) a motion window counts as still; 0 by default. */
  floor?: number
  /** For MCP: every file read must be inside this root. */
  within?: string
}

export type PairReport = {
  element: string
  channel: string
  unit: string
  film: FilmMeasure
  /** How the film's value was scaled into the reference's unit; null when it was not. */
  scaled: { factor: number; axis: 'x' | 'y'; from: [number, number]; to: [number, number] } | null
  /** Seconds between the reference's samples; null when they are not evenly spaced. */
  step: number | null
  /** Samples where both sides have a value. */
  compared: number
  /** The samples with no film time (before 0, or at or after its duration), not compared: how
   * many, and the first and last one's source time; null when none. */
  left: { count: number; first: number; last: number } | null
  /** |film − reference| over those samples, in the reference's unit; null when none. */
  difference: { max: number; mean: number } | null
  offset: {
    found: { steps: number; seconds: number; correlation: number } | null
    why?: string
    maxShift: number
    scores: Score[]
  }
  /** Each side's motion window on the film's times; null when it does not change above floor. */
  window: { film: TimedWindow | null; reference: TimedWindow | null }
  samples: {
    /** The film's time: at − offset. */
    t: number
    /** The reference sample's source time. */
    at: number
    reference: number | null
    film: number | null
    difference: number | null
  }[]
}

export type CompareTracksReport = {
  reference: {
    kind: 'reference-tracks'
    file: string
    source: Reference['source']
    frame: Reference['frame']
  }
  film: { width: number; height: number; duration: number }
  offset: number
  floor: number
  pairs: PairReport[]
}

const FORMAT = 'shaderera.analysis/1'
const KIND = 'reference-tracks'
/** Units in pixels of the reference's frame: scaled by the frame ratio. */
const PIXELS = new Set(['css-px', 'source-px'])
/** The axis of the common position channels docs/analysis.md names. */
const AXIS: { [channel: string]: 'x' | 'y' } = {
  x: 'x',
  width: 'x',
  translateX: 'x',
  scrollX: 'x',
  y: 'y',
  height: 'y',
  translateY: 'y',
  scrollY: 'y',
}

type Obj = { [k: string]: unknown }
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isSize = (v: unknown): v is number => isNumber(v) && v > 0
const round6 = (t: number) => Number(t.toFixed(6))
/** How film time follows from source time: `source time + 0.1 s` for --offset=-0.1. */
const readAt = (offset: number) => `source time ${offset < 0 ? `+ ${-offset}` : `− ${offset}`} s`

const readJson = (file: string, flag: string, within?: string): unknown => {
  try {
    return JSON.parse(
      readFileSync(within === undefined ? file : inside(within, file), 'utf8').replace(/^﻿/, ''),
    )
  } catch (e) {
    throw new Error(`${flag} ${file}: ${(e as Error).message}.`)
  }
}

/**
 * Reads a reference-tracks artifact as docs/analysis.md defines it. Refuses another format or
 * kind, a malformed track, and a source file whose bytes are not the ones measured; a live page
 * has no file to check. Fields it does not know are ignored.
 */
export const loadReference = (file: string, root: string, within?: string): Reference => {
  const name = `--compare-tracks ${file}`
  const doc = readJson(file, '--compare-tracks', within)
  if (!isObj(doc)) throw new Error(`${name} is not a JSON object.`)
  if (doc.format !== FORMAT)
    throw new Error(
      `${name} is ${JSON.stringify(doc.format)}, not ${FORMAT}: rebuild it with its analyser.`,
    )
  if (doc.kind !== KIND)
    throw new Error(`${name} is a ${JSON.stringify(doc.kind)} analysis, not ${KIND}.`)
  const s = doc.source
  let source: Reference['source']
  if (isObj(s) && 'path' in s) {
    if (!isText(s.path) || typeof s.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256))
      throw new Error(`${name}'s source file needs a path and a sha256 in hex.`)
    const at = resolve(root, s.path)
    let bytes: Buffer
    try {
      bytes = readFileSync(within === undefined ? at : inside(within, at))
    } catch (e) {
      throw new Error(`${name}'s source ${s.path} cannot be read: ${(e as Error).message}.`)
    }
    if (createHash('sha256').update(bytes).digest('hex') !== s.sha256)
      throw new Error(
        `${name} was measured from other bytes than ${s.path}: run its analyser again.`,
      )
    source = { path: s.path, sha256: s.sha256 }
  } else if (isObj(s) && isText(s.url)) source = { url: s.url }
  else throw new Error(`${name}'s source is neither a file (path) nor a page (url).`)
  const f = doc.frame
  if (!isObj(f) || !isSize(f.width) || !isSize(f.height) || !isSize(f.pixelRatio))
    throw new Error(`${name} needs frame { width, height, pixelRatio }, each above 0.`)
  if (!Array.isArray(doc.tracks)) throw new Error(`${name} has no tracks.`)
  const tracks = doc.tracks.map((tr: unknown, i): Track => {
    if (!isObj(tr) || !isText(tr.element) || !isText(tr.channel) || !isText(tr.unit))
      throw new Error(`${name}'s track ${i} needs an element, a channel and a unit.`)
    const label = `${name}'s track ${i} (${tr.element} ${tr.channel})`
    if (!Array.isArray(tr.samples) || tr.samples.length === 0)
      throw new Error(`${label} has no samples.`)
    let before = Number.NEGATIVE_INFINITY
    for (const [j, sample] of tr.samples.entries()) {
      if (!Array.isArray(sample) || sample.length !== 2 || !isNumber(sample[0]))
        throw new Error(`${label}: sample ${j} is not [seconds, value].`)
      if (sample[1] !== null && !isNumber(sample[1]))
        throw new Error(`${label}: sample ${j}'s value is not a finite number or null.`)
      if (sample[0] <= before)
        throw new Error(`${label}: sample ${j} at ${sample[0]} s is not after the one before.`)
      before = sample[0]
    }
    return {
      element: tr.element,
      channel: tr.channel,
      unit: tr.unit,
      samples: tr.samples as Track['samples'],
    }
  })
  return {
    file,
    source,
    frame: { width: f.width, height: f.height, pixelRatio: f.pixelRatio },
    tracks,
  }
}

/** What --pairs takes, for the messages. */
const PAIRS = `a JSON list of { "element", "channel", "film": { "path": "objects[id=card].x" } or { "id": "card", "channel": "x" } }, the film's channel one of ${DOM_CHANNELS.join(', ')}`

/** Reads the pairs file: each pair is given, never guessed. */
export const loadPairs = (file: string, within?: string): Pair[] => {
  const doc = readJson(file, '--pairs', within)
  if (!Array.isArray(doc) || doc.length === 0)
    throw new Error(`--pairs ${file} is not a list of pairs: give ${PAIRS}.`)
  return doc.map((p: unknown, i): Pair => {
    const bad = (why: string) => new Error(`--pairs ${file}: pair ${i} ${why}: give ${PAIRS}.`)
    if (!isObj(p) || !isText(p.element) || !isText(p.channel))
      throw bad('needs the reference element and channel')
    const f = p.film
    let film: FilmMeasure
    if (isObj(f) && isText(f.path) && f.id === undefined) film = { path: f.path }
    else if (isObj(f) && isText(f.id) && f.path === undefined) {
      if (!DOM_CHANNELS.includes(f.channel as DomChannel))
        throw bad(`measures the DOM element ${f.id} by ${JSON.stringify(f.channel)}`)
      film = { id: f.id, channel: f.channel as DomChannel }
    } else throw bad('needs film: an inspect path, or a DOM element by id and channel')
    if (p.axis !== undefined && p.axis !== 'x' && p.axis !== 'y')
      throw bad(`has axis ${JSON.stringify(p.axis)}, not "x" or "y"`)
    return {
      element: p.element,
      channel: p.channel,
      film,
      ...(p.axis === undefined ? {} : { axis: p.axis as 'x' | 'y' }),
    }
  })
}

/** The change of each value from the one before; null at the first and next to a null. */
const changes = (values: readonly (number | null)[]): Curve =>
  values.map((v, i) => {
    const p = values[i - 1]
    return i === 0 || v === null || p === null || p === undefined ? null : Math.abs(v - p)
  })

const describe = (m: FilmMeasure) => ('path' in m ? m.path : `data-id ${m.id} ${m.channel}`)

/**
 * Measures each pair (see CompareTracksOptions): the film at each reference sample's source time
 * minus offset, in the reference's unit; samples with no film time are left out, and counted.
 * Throws on bad input: a refused file, a pair whose track or film side is not there, a pair with
 * no sample in the film's time.
 */
export const compareTracks = async (o: CompareTracksOptions): Promise<CompareTracksReport> => {
  const offset = o.offset ?? 0
  if (!Number.isFinite(offset)) throw new Error(`--offset is seconds, not ${o.offset}.`)
  const floor = o.floor ?? 0
  if (!(Number.isFinite(floor) && floor >= 0))
    throw new Error(`--floor is a change in the channel's unit, 0 or more, not ${o.floor}.`)
  if (o.maxShift !== undefined && !(Number.isInteger(o.maxShift) && o.maxShift >= 0))
    throw new Error(`--max-shift is a whole number of steps, 0 or more, not ${o.maxShift}.`)
  const ref = loadReference(o.reference, o.root, o.within)
  const pairs = loadPairs(o.pairs, o.within)
  const { film } = o
  const name = `--compare-tracks ${o.reference}`

  // Every pair is checked before anything is measured.
  const planned = pairs.map((p, i) => {
    const label = `pair ${i} (${p.element} ${p.channel})`
    const track = ref.tracks.find((q) => q.element === p.element && q.channel === p.channel)
    if (!track) {
      const of = ref.tracks.filter((q) => q.element === p.element).map((q) => q.channel)
      throw new Error(
        of.length > 0
          ? `${label}: ${name} has no ${p.channel} for ${p.element}: it has ${of.join(', ')}.`
          : `${label}: ${name} has no element ${p.element}: it has ${[...new Set(ref.tracks.map((q) => q.element))].join(', ') || 'no tracks'}.`,
      )
    }
    if ('path' in p.film && !film.inspect)
      throw new Error(
        `${label}: the film is measured at ${p.film.path}, and this source has no inspect(t).`,
      )
    if ('id' in p.film && !film.elements)
      throw new Error(
        `${label}: the film is measured by the DOM element ${p.film.id}, and this project has no DOM (manifest.dom, browser host).`,
      )
    const inFilm = ([at]: Track['samples'][number]) =>
      at - offset >= 0 && at - offset < film.duration
    const samples = track.samples.filter(inFilm)
    if (samples.length === 0) {
      const ats = track.samples.map(([at]) => round6(at))
      throw new Error(
        `${label}: no sample in the film's time (0 to ${film.duration} s): its samples run ${ats[0]} to ${ats.at(-1)} s, read at ${readAt(offset)}.`,
      )
    }
    const out = track.samples.filter((s) => !inFilm(s)).map(([at]) => at)
    const left: PairReport['left'] =
      out.length === 0
        ? null
        : { count: out.length, first: out[0] as number, last: out.at(-1) as number }
    let scaled: PairReport['scaled'] = null
    if (PIXELS.has(track.unit)) {
      const axis = p.axis ?? AXIS[track.channel]
      if (!axis)
        throw new Error(
          `${label}: its unit ${track.unit} is scaled by the frame's width or height, and ${track.channel} names neither: give "axis": "x" or "y" in the pair.`,
        )
      const factor = axis === 'x' ? ref.frame.width / film.width : ref.frame.height / film.height
      if (factor !== 1)
        scaled = {
          factor,
          axis,
          from: [film.width, film.height],
          to: [ref.frame.width, ref.frame.height],
        }
    }
    return { pair: p, label, track: { ...track, samples }, left, scaled }
  })

  // Each time is measured once for every pair that needs it.
  const inspected = new Map<number, Promise<Json>>()
  const drawn = new Map<number, Promise<DomElement[]>>()
  const once = <T>(cache: Map<number, Promise<T>>, t: number, get: (t: number) => Promise<T>) => {
    const key = round6(t)
    let v = cache.get(key)
    if (!v) {
      v = get(key)
      cache.set(key, v)
    }
    return v
  }
  const measure = async (m: FilmMeasure, t: number, label: string): Promise<number | null> => {
    if ('path' in m) {
      const v = valueAt(
        await once(inspected, t, film.inspect as (t: number) => Promise<Json>),
        m.path,
      )
      if (v === undefined || v === null) return null
      if (!isNumber(v))
        throw new Error(
          `${label}: ${m.path} at t = ${round6(t)} s is ${JSON.stringify(v)}, not a number.`,
        )
      return v
    }
    const all = (
      await once(drawn, t, film.elements as (t: number) => Promise<DomElement[]>)
    ).filter((e) => e.id === m.id)
    if (all.length > 1)
      throw new Error(
        `${label}: ${all.length} elements have data-id ${m.id} at t = ${round6(t)} s.`,
      )
    const e = all[0]
    if (!e) return null
    return m.channel === 'opacity' ? e.opacity : (e.box[DOM_CHANNELS.indexOf(m.channel)] as number)
  }

  const reports: PairReport[] = []
  for (const { pair, label, track, left, scaled } of planned) {
    const factor = scaled?.factor ?? 1
    const ats = track.samples.map(([at]) => at)
    const times = ats.map((at) => at - offset)
    const step = stepOf(ats)
    let maxShift = 0
    let why: string | undefined
    if (step === null)
      why =
        ats.length < 2
          ? 'one sample has no change'
          : "the reference's samples are not evenly spaced"
    else maxShift = o.maxShift ?? Math.round(1 / step)
    // The film is also measured up to maxShift steps before the first sample and after the last,
    // where it has time, so every shift is measured over all the reference's samples.
    const before: number[] = []
    const after: number[] = []
    if (step !== null)
      for (let k = 1; k <= maxShift; k++) {
        const early = (times[0] as number) - k * step
        const late = (times.at(-1) as number) + k * step
        if (early >= -1e-9) before.unshift(Math.max(0, early))
        if (late < film.duration - 1e-9) after.push(late)
      }
    const lead = before.length
    const measured: (number | null)[] = []
    for (const t of [...before, ...times, ...after]) {
      const v = await measure(pair.film, t, label)
      measured.push(v === null ? null : v * factor)
    }
    const filmValues = measured.slice(lead, lead + times.length)
    if (filmValues.every((v) => v === null))
      throw new Error(
        'path' in pair.film
          ? `${label}: nothing at ${pair.film.path} in inspect at any of its samples.`
          : `${label}: no element with data-id ${pair.film.id} in the DOM at any of its samples.`,
      )
    const samples = track.samples.map(([at, r], i) => {
      const f = filmValues[i] as number | null
      return {
        t: round6(times[i] as number),
        at,
        reference: r,
        film: f,
        difference: f === null || r === null ? null : f - r,
      }
    })
    const both = samples.flatMap((s) => (s.difference === null ? [] : [Math.abs(s.difference)]))
    const refCurve = changes(track.samples.map(([, r]) => r))
    const filmCurve = changes(measured)
    // Shift k pairs the reference's sample i with the film's i + k: the film moves k steps later,
    // so the reference moves -k steps later, as --offset counts it.
    const a = step === null ? undefined : align(refCurve, filmCurve, maxShift, lead)
    if (a && a.shift === null)
      why = 'a track does not change over enough of its samples to correlate'
    const timed = (w: ReturnType<typeof motionWindow>): TimedWindow | null =>
      w && {
        first: round6(times[w.first] as number),
        last: round6(times[w.last] as number),
        peak: { t: round6(times[w.peak.index] as number), change: w.peak.change },
      }
    const steps = a?.shift ? -a.shift : 0
    reports.push({
      element: track.element,
      channel: track.channel,
      unit: track.unit,
      film: pair.film,
      scaled,
      step: step === null ? null : round6(step),
      compared: both.length,
      left,
      difference:
        both.length === 0
          ? null
          : { max: Math.max(...both), mean: both.reduce((x, y) => x + y, 0) / both.length },
      offset: {
        found:
          a && a.shift !== null
            ? {
                steps,
                seconds: round6(steps * (step as number)),
                correlation: a.correlation as number,
              }
            : null,
        ...(why && !(a && a.shift !== null) ? { why } : {}),
        maxShift,
        // Each score's shift as --offset counts it.
        scores: (a?.scores ?? [])
          .map((s) => ({ ...s, shift: s.shift === 0 ? 0 : -s.shift }))
          .reverse(),
      },
      window: {
        film: timed(
          motionWindow(
            filmCurve.slice(lead, lead + times.length).map((c, i) => (i === 0 ? null : c)),
            floor,
          ),
        ),
        reference: timed(motionWindow(refCurve, floor)),
      },
      samples,
    })
  }
  return {
    reference: { kind: KIND, file: o.reference, source: ref.source, frame: ref.frame },
    film: { width: film.width, height: film.height, duration: film.duration },
    offset,
    floor,
    pairs: reports,
  }
}

/** The report as lines: the reference, then each pair's difference, offset and motion windows. */
export const trackLines = (r: CompareTracksReport): string[] => {
  const n = (x: number) => String(Number(x.toFixed(4)))
  const f = r.reference.frame
  const lines = [
    `reference: ${r.reference.file}, frame ${f.width}×${f.height} at pixel ratio ${f.pixelRatio}; film ${r.film.width}×${r.film.height}, ${r.film.duration} s; measured at ${readAt(r.offset)}`,
  ]
  const win = (w: TimedWindow | null) =>
    w
      ? `moves ${w.first.toFixed(3)}–${w.last.toFixed(3)} s, peak ${w.peak.t.toFixed(3)} s (${n(w.peak.change)})`
      : 'still'
  for (const p of r.pairs) {
    lines.push(`${p.element} ${p.channel} (${p.unit}) vs ${describe(p.film)}`)
    if (p.scaled)
      lines.push(
        `  scaled: the film's value × ${n(p.scaled.factor)} (${p.scaled.axis}: ${p.scaled.from.join('×')} film to ${p.scaled.to.join('×')} reference)`,
      )
    lines.push(
      p.difference
        ? `  difference: max ${n(p.difference.max)}, mean ${n(p.difference.mean)} ${p.unit} over ${p.compared} samples`
        : '  difference: no sample where both have a value',
    )
    if (p.left)
      lines.push(
        `  left out: ${p.left.count} sample${p.left.count === 1 ? '' : 's'} with no film time (0 to ${r.film.duration} s), at source ${p.left.first === p.left.last ? `${p.left.first} s` : `${p.left.first} to ${p.left.last} s`}`,
      )
    lines.push(
      `  film ${win(p.window.film)}; reference ${win(p.window.reference)}${r.floor > 0 ? ` (above ${r.floor})` : ''}`,
    )
    const o = p.offset
    if (o.found) {
      const total = round6(r.offset + o.found.seconds)
      const late =
        o.found.steps === 0
          ? 'in step'
          : o.found.steps < 0
            ? `the film ${-o.found.steps} steps later`
            : `the film ${o.found.steps} steps earlier`
      lines.push(
        `  offset: aligns best at ${o.found.steps > 0 ? '+' : ''}${o.found.steps} steps of ${n(p.step as number)} s (${n(o.found.seconds)} s, ${late}, correlation ${o.found.correlation.toFixed(3)}), searched ±${o.maxShift}${o.found.steps === 0 ? '' : `. Aligned: --offset=${total}`}`,
      )
    } else lines.push(`  offset: no alignment: ${o.why}`)
  }
  return lines
}
