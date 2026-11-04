// Motion measured from a reference, read as frozen analysis data (shaderera.analysis/1, kind
// "reference-tracks"): one track per element and channel, each a list of [source time, value]
// samples kept at the times they were taken. An analyser writes it once, apart from rendering (a
// web page capture, a video tracker, any tool that writes the same JSON); the film reads data.
// Nothing here retimes, smooths or fits: the film maps its time to source time in its own code
// and says how to fill between samples.

import { type Host, sha256 } from '@shaderera/core'

/** A live page, which cannot be hashed: what was loaded, when, and at what size. */
export type PageSource = {
  url: string
  /** When it was captured, ISO 8601 in UTC. */
  date: string
  /** The layout viewport, in CSS pixels. */
  viewport: { width: number; height: number }
  devicePixelRatio: number
  /**
   * Every response the page loaded, with its status and the sha256 of its body as served (after
   * any Content-Encoding is undone). `hashOf` names what was hashed instead when the bytes were
   * not available: `text-as-utf8` is the body as the browser decoded it, encoded as UTF-8.
   */
  responses: { url: string; status: number; sha256: string; hashOf?: string }[]
}

/** One sample: the source time in seconds, and the value then, or null where there was none. */
export type Sample = [time: number, value: number | null]

/** One element's one channel. */
export type Track = {
  /** The element, as the analyser names it: a CSS selector for a page, a tracker's label. */
  element: string
  /** `x`, `y`, `width`, `height`, `opacity`, `rotate`, `scaleX`… or a custom name. */
  channel: string
  /** `css-px`, `source-px`, `deg`, `ratio`… */
  unit: string
  /** At strictly increasing source times. */
  samples: Sample[]
  /** Fields a later analyser adds, kept as written. */
  [key: string]: unknown
}

/** What the source declared about an element's motion, kept as written (keyframes, easing). */
export type Declared = { element: string; type: string; [key: string]: unknown }

/** Something the analyser could not make exact, and where. */
export type Limit = {
  /** What it is about: an element, a URL, a part of the source. */
  where: string
  reason: string
  /** The source seconds it covers, when it covers only some. */
  from?: number
  to?: number
}

/** What a reference-tracks artifact holds, and the path it was read from. */
export type ReferenceTracks = {
  format: 'shaderera.analysis/1'
  kind: 'reference-tracks'
  /** A file (its path from the project root, bytes and sha256), or a live page. */
  source: { path: string; bytes: number; sha256: string } | PageSource
  /** The analyser and its versions: provenance only, nothing here is read to render. */
  tool: Record<string, unknown>
  /** Every setting that changed the output (fps, rafHz, seed, trigger…). */
  params: Record<string, unknown>
  /** The source's frame: its size in the unit of its position tracks, and its pixel ratio. */
  frame: { width: number; height: number; pixelRatio: number }
  tracks: Track[]
  declared: Declared[]
  limits: Limit[]
  path: string
}

const KIND = 'reference-tracks'
const HEX = /^[0-9a-f]{64}$/
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isSize = (v: unknown) => isNumber(v) && v > 0
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0
/** ISO 8601 in UTC, as Date.prototype.toISOString writes it, seconds or finer. */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Whether a source names a file, which is hashed again at load. */
export const isFileSource = (
  source: ReferenceTracks['source'],
): source is { path: string; bytes: number; sha256: string } => 'path' in source

/**
 * What is wrong with an artifact's `source`, a file or a live page, or nothing. Every reference
 * kind (reference-tracks, reference-style) checks its source with it, so they read one the same.
 */
export const sourceProblem = (s: unknown, name: string): string | undefined => {
  if (!isObject(s)) return `${name} has no source`
  if ('path' in s) {
    if (!isText(s.path) || !isCount(s.bytes) || typeof s.sha256 !== 'string' || !HEX.test(s.sha256))
      return `${name}'s source file needs a path, its bytes (a whole number) and a sha256 in hex`
  } else if ('url' in s) {
    const v = s.viewport
    if (!isText(s.url) || !isText(s.date) || !isObject(v) || !isSize(v.width) || !isSize(v.height))
      return `${name}'s source page needs a url, a date and a viewport { width, height }`
    if (typeof s.date !== 'string' || !UTC.test(s.date))
      return `${name}'s source page date is ${JSON.stringify(s.date)}, not ISO 8601 in UTC (2026-11-04T08:00:00.000Z)`
    if (!isSize(s.devicePixelRatio)) return `${name}'s source page needs a devicePixelRatio`
    if (!Array.isArray(s.responses)) return `${name}'s source page needs its responses`
    const bad = s.responses.findIndex(
      (r) =>
        !isObject(r) ||
        !isText(r.url) ||
        !Number.isInteger(r.status) ||
        typeof r.sha256 !== 'string' ||
        !HEX.test(r.sha256),
    )
    if (bad >= 0)
      return `${name}'s source response ${bad} needs a url, a status and a sha256 in hex`
  } else return `${name}'s source is neither a file (path) nor a page (url)`
  return undefined
}

/**
 * What is wrong with a parsed artifact, as one message naming the first problem, or nothing. Used
 * by `loadTracks` and by the writer in tools/reference-tracks.ts, so what one writes the other
 * reads. Fields it does not know are kept: a compatible addition needs no new number.
 */
export const tracksProblem = (doc: unknown, name: string): string | undefined => {
  if (!isObject(doc)) return `${name} is not a JSON object`
  if (doc.format !== 'shaderera.analysis/1')
    return `${name} is ${JSON.stringify(doc.format)}, not shaderera.analysis/1; rebuild it with its analyser`
  if (doc.kind !== KIND)
    return `${name} is a ${JSON.stringify(doc.kind)} analysis, not ${KIND}${
      doc.kind === 'reference-style' ? ': read it with loadStyle, from analysis-web-capture' : ''
    }`
  const source = sourceProblem(doc.source, name)
  if (source) return source
  if (!isObject(doc.tool)) return `${name} has no tool`
  if (!isObject(doc.params)) return `${name} has no params`
  const f = doc.frame
  if (!isObject(f) || !isSize(f.width) || !isSize(f.height) || !isSize(f.pixelRatio))
    return `${name} needs frame { width, height, pixelRatio }, each above 0`
  if (!Array.isArray(doc.tracks)) return `${name} has no tracks`
  const seen = new Set<string>()
  for (const [i, tr] of doc.tracks.entries()) {
    if (!isObject(tr) || !isText(tr.element) || !isText(tr.channel) || !isText(tr.unit))
      return `${name}'s track ${i} needs an element, a channel and a unit`
    const label = `${name}'s track ${i} (${tr.element} ${tr.channel})`
    const key = JSON.stringify([tr.element, tr.channel])
    if (seen.has(key)) return `${label} is there twice`
    seen.add(key)
    if (!Array.isArray(tr.samples) || tr.samples.length === 0) return `${label} has no samples`
    let before = Number.NEGATIVE_INFINITY
    for (const [j, sample] of tr.samples.entries()) {
      if (!Array.isArray(sample) || sample.length !== 2 || !isNumber(sample[0]))
        return `${label}: sample ${j} is not [seconds, value]`
      if (sample[1] !== null && !isNumber(sample[1]))
        return `${label}: sample ${j}'s value is not a finite number or null`
      if (sample[0] <= before)
        return `${label}: sample ${j} at ${sample[0]} s is not after the one before`
      before = sample[0]
    }
  }
  if (!Array.isArray(doc.declared)) return `${name}'s declared needs to be a list`
  const d = doc.declared.findIndex((e) => !isObject(e) || !isText(e.element) || !isText(e.type))
  if (d >= 0) return `${name}'s declared ${d} needs to name its element and its type`
  if (!Array.isArray(doc.limits)) return `${name}'s limits need to be a list`
  for (const [i, l] of doc.limits.entries()) {
    if (!isObject(l) || !isText(l.where) || !isText(l.reason))
      return `${name}'s limit ${i} needs a where and a reason`
    if (('from' in l && !isNumber(l.from)) || ('to' in l && !isNumber(l.to)))
      return `${name}'s limit ${i} (${l.where}): from and to are source seconds`
    if (isNumber(l.from) && isNumber(l.to) && l.from > l.to)
      return `${name}'s limit ${i} (${l.where}): from ${l.from} s is after to ${l.to} s`
  }
  return undefined
}

/**
 * Reads a reference-tracks artifact. Refuses another format or kind, a malformed one, and a
 * source file whose bytes are not the ones measured: motion copied from a changed reference would
 * not match it. A page source has no file to check; its `responses` say what was loaded.
 */
export const loadTracks = async (host: Host, path: string): Promise<ReferenceTracks> => {
  const text = new TextDecoder().decode(await host.io.read(path))
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`${path} is not JSON (${(e as Error).message}); rebuild it with its analyser`)
  }
  const wrong = tracksProblem(doc, path)
  if (wrong) throw new Error(wrong)
  const tracks = doc as Omit<ReferenceTracks, 'path'>
  if (isFileSource(tracks.source)) {
    const { path: file, sha256: expected } = tracks.source
    if ((await sha256(await host.io.read(file))) !== expected)
      throw new Error(`${path} was measured from other bytes than ${file}; run its analyser again`)
  }
  return { ...tracks, path }
}

/** One element's one channel. Refuses a missing one, naming what there is. */
export const track = (tracks: ReferenceTracks, element: string, channel: string): Track => {
  const found = tracks.tracks.find((q) => q.element === element && q.channel === channel)
  if (found) return found
  const of = tracks.tracks.filter((q) => q.element === element).map((q) => q.channel)
  if (of.length > 0)
    throw new Error(`${tracks.path} has no ${channel} for ${element}: it has ${of.join(', ')}`)
  const elements = [...new Set(tracks.tracks.map((q) => q.element))]
  throw new Error(
    `${tracks.path} has no element ${element}: it has ${elements.join(', ') || 'no tracks'}`,
  )
}

/** How to fill between two samples: the earlier one held, or a straight line to the next. */
export type Between = 'hold' | 'linear'

/**
 * The track's value at `sourceTime` seconds. `between` is required, since it changes the frame.
 * Before the first sample it is null; at a sample's time, that sample's value; after the last,
 * the last value, held. `linear` next to a null sample holds the earlier one.
 */
export const at = (
  tr: Track,
  sourceTime: number,
  { between }: { between: Between },
): number | null => {
  if (between !== 'hold' && between !== 'linear')
    throw new Error(`at() needs between: 'hold' or 'linear', not ${JSON.stringify(between)}`)
  if (!Number.isFinite(sourceTime))
    throw new Error(`at() needs a finite source time, not ${sourceTime}`)
  const s = tr.samples
  const first = s[0]
  if (!first || sourceTime < first[0]) return null
  // The last sample at or before sourceTime.
  let lo = 0
  let hi = s.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((s[mid] as Sample)[0] <= sourceTime) lo = mid
    else hi = mid - 1
  }
  const [t0, v0] = s[lo] as Sample
  const next = s[lo + 1]
  if (between === 'hold' || !next || t0 === sourceTime) return v0
  const [t1, v1] = next
  if (v0 === null || v1 === null) return v0
  return v0 + ((v1 - v0) * (sourceTime - t0)) / (t1 - t0)
}
