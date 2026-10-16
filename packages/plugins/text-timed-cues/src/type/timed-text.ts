// Timed text: lyrics, subtitles and word timings, read once in open and asked for by t in render.
// LRC (with <mm:ss.xx> word times), SRT and WebVTT, and JSON (rows of [start, end, "line"], cues
// like the ones returned here, Whisper's segments with words, or a transcript's top-level words).
// Times only: how a line looks and moves is the film's code.

import type { Host } from '@shaderera/core'

export type Word = { readonly start: number; readonly end: number; readonly text: string }
export type Cue = {
  readonly start: number
  /** When the next cue starts, for formats that give only starts (LRC); Infinity for the last. */
  readonly end: number
  readonly text: string
  /** Word times, when the source has them. */
  readonly words?: readonly Word[]
}

const clock = (m: string, s: string, h = '0') => Number(h) * 3600 + Number(m) * 60 + Number(s)

/** Ends each cue where the next starts, unless it already has an end. */
const chain = (cues: { start: number; end?: number; text: string; words?: Word[] }[]): Cue[] => {
  const sorted = [...cues].sort((a, b) => a.start - b.start)
  return sorted.map((c, i) => ({
    ...c,
    end: c.end ?? sorted[i + 1]?.start ?? Number.POSITIVE_INFINITY,
  }))
}

/**
 * LRC: `[mm:ss.xx] line`, several stamps on one line for a repeated line, and enhanced LRC's
 * `<mm:ss.xx>` before each word. Tags such as `[ar:…]` and `[offset:+250]` (ms, added to every
 * time, as the format says) are read; lines without a time are skipped.
 */
export const parseLrc = (source: string): Cue[] => {
  const offset = Number(/^\[offset:\s*([+-]?\d+)\]/im.exec(source)?.[1] ?? 0) / 1000
  const cues: { start: number; text: string; words?: Word[] }[] = []
  const stamp = /\[(\d+):(\d+(?:\.\d+)?)\]/g
  for (const line of source.split(/\r?\n/)) {
    const starts = [...line.matchAll(stamp)].map((m) => clock(m[1] ?? '0', m[2] ?? '0') + offset)
    if (starts.length === 0) continue
    const body = line.replace(stamp, '')
    const marks = [...body.matchAll(/<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g)]
    const text = body.replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim()
    for (const start of starts) {
      if (marks.length === 0) {
        cues.push({ start, text })
        continue
      }
      const times = marks.map((m) => clock(m[1] ?? '0', m[2] ?? '0') + offset)
      const words = marks.flatMap((m, i) => {
        const word = (m[3] ?? '').trim()
        return word
          ? [{ start: times[i] as number, end: times[i + 1] ?? Number.NaN, text: word }]
          : []
      })
      cues.push({ start, text, words })
    }
  }
  const chained = chain(cues)
  // A last word without a closing time ends with its line.
  return chained.map((c) =>
    c.words
      ? { ...c, words: c.words.map((w) => (Number.isNaN(w.end) ? { ...w, end: c.end } : w)) }
      : c,
  )
}

/** SRT and WebVTT: numbered or unnumbered blocks of `start --> end` and their text lines. */
export const parseSrt = (source: string): Cue[] => {
  const time = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[,.](\d+)/
  const cues: { start: number; end: number; text: string }[] = []
  for (const block of source.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => time.test(l))
    if (at < 0) continue
    const m = time.exec(lines[at] as string) as RegExpExecArray
    const s = (h?: string, mm?: string, ss?: string, ms?: string) =>
      clock(mm ?? '0', `${ss ?? '0'}.${ms ?? '0'}`, h ?? '0')
    cues.push({
      start: s(m[1], m[2], m[3], m[4]),
      end: s(m[5], m[6], m[7], m[8]),
      text: lines
        .slice(at + 1)
        .join('\n')
        .replace(/<[^>]+>/g, '')
        .trim(),
    })
  }
  return chain(cues)
}

type Json = unknown
const num = (v: Json) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: Json) => (typeof v === 'string' ? v : undefined)
const wordOf = (w: Json): Word[] => {
  const o = (w ?? {}) as { start?: Json; end?: Json; t?: Json; text?: Json; word?: Json }
  const start = num(o.start) ?? num(o.t)
  const text = (str(o.text) ?? str(o.word))?.trim()
  return start === undefined || !text ? [] : [{ start, end: num(o.end) ?? start, text }]
}

/**
 * JSON timings: rows of `[start, end, "line"]`; cues `{ start, end?, text, words? }`; Whisper's
 * `{ segments: [{ start, end, text, words: [{ start, end, word }] }] }`; or a speech-to-text
 * transcript's `{ text?, words: [{ start, end, text | word }] }` (Paxa Labs), read as one cue
 * from its first word's start to its last word's end.
 */
export const parseTimedJson = (json: Json): Cue[] => {
  const top = (json ?? {}) as { segments?: Json; words?: Json; text?: Json }
  if (!Array.isArray(json) && top.segments === undefined && Array.isArray(top.words)) {
    const words = top.words.flatMap(wordOf)
    const first = words[0]
    const last = words.at(-1)
    if (!first || !last) return []
    const text = str(top.text)?.trim() ?? words.map((w) => w.text).join(' ')
    return [{ start: first.start, end: last.end, text, words }]
  }
  const rows = Array.isArray(json)
    ? json
    : ((json as { segments?: Json[] } | null)?.segments ?? undefined)
  if (!Array.isArray(rows))
    throw new Error(
      'Timed text JSON needs an array of rows or cues, Whisper segments or a words array.',
    )
  return chain(
    rows.flatMap((r) => {
      if (Array.isArray(r)) {
        const [start, end, text] = r
        return num(start) === undefined || str(text) === undefined
          ? []
          : [{ start: num(start) as number, end: num(end), text: (str(text) as string).trim() }]
      }
      const o = (r ?? {}) as { start?: Json; end?: Json; text?: Json; words?: Json }
      const words = Array.isArray(o.words) ? o.words.flatMap(wordOf) : undefined
      const start = num(o.start) ?? words?.[0]?.start
      if (start === undefined) return []
      const text = str(o.text)?.trim() ?? words?.map((w) => w.text).join(' ') ?? ''
      return [{ start, end: num(o.end), text, ...(words?.length ? { words } : {}) }]
    }),
  )
}

/** Reads timed text by its extension: `.lrc`, `.srt`, `.vtt` or `.json`. */
export const parseTimedText = (path: string, source: string): Cue[] => {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (ext === 'lrc') return parseLrc(source)
  if (ext === 'srt' || ext === 'vtt') return parseSrt(source)
  if (ext === 'json') return parseTimedJson(JSON.parse(source))
  throw new Error(`${path}: timed text is .lrc, .srt, .vtt or .json.`)
}

/** Shifts every time by `-trim`: the seconds of the source the film leaves out at its start. */
export const trimCues = (cues: readonly Cue[], trim: number): Cue[] =>
  cues.map((c) => ({
    ...c,
    start: c.start - trim,
    end: c.end - trim,
    ...(c.words
      ? { words: c.words.map((w) => ({ ...w, start: w.start - trim, end: w.end - trim })) }
      : {}),
  }))

/** Reads a project file of timed text in `open`, its times shifted by `-trim` (see trimCues). */
export const loadTimedText = async (host: Host, path: string, o: { trim?: number } = {}) =>
  trimCues(parseTimedText(path, new TextDecoder().decode(await host.io.read(path))), o.trim ?? 0)

/** The cue showing at t, or undefined between cues. */
export const cueAt = (cues: readonly Cue[], t: number): Cue | undefined =>
  cues.find((c) => c.start <= t && t < c.end)

/** The word being sung at t: the last word of the cue at t that has started. */
export const wordAt = (cues: readonly Cue[], t: number): Word | undefined => {
  const words = cueAt(cues, t)?.words ?? []
  let found: Word | undefined
  for (const w of words) if (w.start <= t) found = w
  return found
}
