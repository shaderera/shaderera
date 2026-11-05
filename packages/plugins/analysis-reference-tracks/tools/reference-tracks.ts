// The one writer of reference-tracks artifacts, for analysers: a web page capture, a video
// tracker, any tool that measures motion. Every analyser that writes through it writes the same
// bytes for the same measurements, so two captures of one source can be compared byte for byte.
//   import { fileSource, tracksJson } from './reference-tracks.ts'
//   writeFileSync('references/hero.tracks.json', tracksJson({ format, kind, source, ... }))
//
// - Keys come in one order: the header (format, kind, source, tool, params), then frame, tracks,
//   declared and limits. A track is element, channel, unit, samples, then any field a later
//   analyser adds, kept as written. Inside tool, params, declared and limits, a source's other
//   fields and a track's added ones, keys are sorted by code unit.
// - Tracks are sorted by element, then channel; a page's responses by url, status and sha256 (the
//   order a page loads them in changes from run to run). Declared and limits keep their order.
// - A sample's time is rounded to TIME_DIGITS decimals (a microsecond), its value to VALUE_DIGITS
//   (1/10000 of its unit). Declared values are kept as written, not rounded.
// - It refuses what loadTracks would refuse, samples that rounding puts at one time, a value
//   too large to round, and a NaN, infinite or undefined value anywhere JSON would turn it into
//   null or drop it. A top-level field it does not know is refused: put it in params or tool.

import { sha256 } from '@shaderera/core'
import {
  isFileSource,
  type ReferenceTracks,
  type Sample,
  type Track,
  tracksProblem,
} from '../src/reference/tracks.ts'

/** Decimals kept in a sample's time, in seconds. */
export const TIME_DIGITS = 6
/** Decimals kept in a sample's value, in its unit. */
export const VALUE_DIGITS = 4

/** What an analyser hands the writer: an artifact without the path it is read from. */
export type TracksDoc = Omit<ReferenceTracks, 'path'>

const TOP = ['format', 'kind', 'source', 'tool', 'params', 'frame', 'tracks', 'declared', 'limits']
const FILE = ['path', 'bytes', 'sha256']
const PAGE = ['url', 'date', 'viewport', 'devicePixelRatio', 'responses']

/**
 * `x` rounded to `digits` decimals, to the nearest, ties away from zero on the binary value, with
 * no -0. Refuses a value too large to round (it would turn into Infinity, written as null).
 */
export const round = (x: number, digits: number) => {
  const k = 10 ** digits
  const r = (Math.sign(x) * Math.round(Math.abs(x) * k)) / k
  if (!Number.isFinite(r)) throw new Error(`${x} is too large to round to ${digits} decimals`)
  return r === 0 ? 0 : r
}

/** The file a measurement was made from, as `source`: its path from the project root. */
export const fileSource = async (path: string, bytes: Uint8Array) => ({
  path,
  bytes: bytes.length,
  sha256: await sha256(bytes),
})

/**
 * Every object's keys sorted, recursively; arrays keep their order. Refuses, naming `path` (what
 * the value is, like "the reference tracks' params"), a value JSON would change without a word: a
 * NaN or infinite number (written as null) and undefined (dropped).
 */
export const sorted = (v: unknown, path: string): unknown => {
  if (v === undefined) throw new Error(`${path} is undefined`)
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${path} is ${v}`)
  if (Array.isArray(v)) return v.map((e, i) => sorted(e, `${path}[${i}]`))
  if (typeof v !== 'object' || v === null) return v
  const o = v as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(o)
      .sort(byCode)
      .map((k) => [k, sorted(o[k], `${path}.${k}`)]),
  )
}
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** `first` in that order with their values as they are, then the rest sorted, recursively. */
export const ordered = (o: Record<string, unknown>, first: string[], path: string) => {
  const rest = Object.keys(o)
    .filter((k) => !first.includes(k))
    .sort(byCode)
  return Object.fromEntries([
    ...first.filter((k) => k in o).map((k) => [k, o[k]]),
    ...rest.map((k) => [k, sorted(o[k], `${path}.${k}`)]),
  ])
}
/**
 * A source in its stable order: a file's path, bytes and sha256; a page's url, date, viewport,
 * pixel ratio and responses, sorted by url, status and sha256. Every reference kind writes it so.
 */
export const sourceJson = (source: TracksDoc['source'], path: string) =>
  isFileSource(source)
    ? ordered(source, FILE, path)
    : ordered(
        {
          ...source,
          viewport: ordered(source.viewport, ['width', 'height'], `${path}.viewport`),
          responses: [...source.responses]
            .sort(
              (a, b) =>
                byCode(a.url, b.url) ||
                a.status - b.status ||
                byCode(a.sha256 ?? '', b.sha256 ?? ''),
            )
            .map((r, i) => ordered(r, ['url', 'status', 'sha256'], `${path}.responses[${i}]`)),
        },
        PAGE,
        path,
      )
const json = (v: unknown, indent: string) =>
  JSON.stringify(v, null, 2).replaceAll('\n', `\n${indent}`)

/**
 * The artifact as the bytes to write: rounded, in a stable order, one track per line, with a
 * final newline. Refuses a document loadTracks would refuse, naming what is wrong.
 */
export const tracksJson = (doc: TracksDoc): string => {
  const T = "the reference tracks' "
  const extra = Object.keys(doc).filter((k) => !TOP.includes(k))
  if (extra.length > 0)
    throw new Error(`reference-tracks has no field ${extra.join(', ')}: put it in params or tool`)
  const wrong = tracksProblem(doc, 'the reference tracks')
  if (wrong) throw new Error(wrong)
  const tracks: Track[] = doc.tracks
    .map((tr) => {
      const samples = tr.samples.map(([t, v], j): Sample => {
        try {
          return [round(t, TIME_DIGITS), v === null ? null : round(v, VALUE_DIGITS)]
        } catch (e) {
          throw new Error(
            `the reference tracks' ${tr.element} ${tr.channel}: sample ${j}: ${(e as Error).message}`,
          )
        }
      })
      for (let j = 1; j < samples.length; j++)
        if ((samples[j] as Sample)[0] <= (samples[j - 1] as Sample)[0])
          throw new Error(
            `the reference tracks' ${tr.element} ${tr.channel}: samples ${j - 1} and ${j} round to one time`,
          )
      return ordered(
        { ...tr, samples },
        ['element', 'channel', 'unit', 'samples'],
        `${T}${tr.element} ${tr.channel}`,
      ) as Track
    })
    .sort((a, b) => byCode(a.element, b.element) || byCode(a.channel, b.channel))
  const head = [
    `"format": ${JSON.stringify(doc.format)}`,
    `"kind": ${JSON.stringify(doc.kind)}`,
    `"source": ${json(sourceJson(doc.source, `${T}source`), '  ')}`,
    `"tool": ${json(sorted(doc.tool, `${T}tool`), '  ')}`,
    `"params": ${json(sorted(doc.params, `${T}params`), '  ')}`,
    `"frame": ${JSON.stringify(ordered(doc.frame, ['width', 'height', 'pixelRatio'], `${T}frame`))}`,
  ]
  const lines = tracks.map((tr) => `    ${JSON.stringify(tr)}`)
  const body = [
    `"tracks": [${lines.length > 0 ? `\n${lines.join(',\n')}\n  ` : ''}]`,
    `"declared": ${json(
      doc.declared.map((e, i) => sorted(e, `${T}declared[${i}]`)),
      '  ',
    )}`,
    `"limits": ${json(
      doc.limits.map((l, i) => ordered(l, ['where', 'reason', 'from', 'to'], `${T}limits[${i}]`)),
      '  ',
    )}`,
  ]
  return `{\n  ${[...head, ...body].join(',\n  ')}\n}\n`
}
