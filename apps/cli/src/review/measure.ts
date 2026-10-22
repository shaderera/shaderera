// Pure measurements over RGBA frames and inspect JSON, shared by review's checks and its tests.
import type { Json } from '@shaderera/core'

export type Frame = { t: number; pixels: Uint8Array; width: number; height: number }
export type TextRun = {
  id: string
  role?: string
  text: string
  font?: string
  size?: number
  box: [number, number, number, number]
  opacity?: number
  /**
   * The fonts that drew this text, as the browser reports them (browser host, DOM text): `custom`
   * for a web font the page loaded, else a system font. Absent where the host cannot tell.
   */
  rendered?: { family: string; custom: boolean; glyphs: number }[]
}
/**
 * A shot from inspect: a moment `{ id, at }` or a span `{ id, start, end }` (on screen from `start`
 * up to `end`). `at` is the time review looks at: for a span, the middle of the part no other shot
 * overlaps.
 */
export type Shot = { id?: string; at: number; start?: number; end?: number; label?: string }

const luma = (px: Uint8Array, k: number) =>
  0.2126 * (px[k] as number) + 0.7152 * (px[k + 1] as number) + 0.0722 * (px[k + 2] as number)

/** Mean luma, luma standard deviation, % clipped (≥ 250), % crushed (≤ 5) and % non-opaque. */
export const frameStats = (px: Uint8Array) => {
  let sum = 0
  let sq = 0
  let clipped = 0
  let crushed = 0
  let clear = 0
  const n = px.length / 4
  for (let k = 0; k < px.length; k += 4) {
    const y = luma(px, k)
    sum += y
    sq += y * y
    if (y >= 250) clipped++
    if (y <= 5) crushed++
    if ((px[k + 3] as number) < 255) clear++
  }
  const mean = sum / n
  return {
    mean,
    std: Math.sqrt(Math.max(0, sq / n - mean * mean)),
    clipped: (100 * clipped) / n,
    crushed: (100 * crushed) / n,
    nonOpaque: clear / n,
  }
}

/** Mean absolute difference per channel (RGBA) between two same-size frames. */
export const meanAbsDiff = (a: Uint8Array, b: Uint8Array): number => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] as number) - (b[i] as number))
  return sum / a.length
}

/** Area-averaged luma on a gw × gh grid. */
export const lumaGrid = (px: Uint8Array, width: number, height: number, gw: number, gh: number) => {
  const out = new Float64Array(gw * gh)
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x0 = Math.floor((i * width) / gw)
      const x1 = Math.floor(((i + 1) * width) / gw)
      const y0 = Math.floor((j * height) / gh)
      const y1 = Math.floor(((j + 1) * height) / gh)
      let sum = 0
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) sum += luma(px, (y * width + x) * 4)
      out[j * gw + i] = sum / Math.max(1, (x1 - x0) * (y1 - y0))
    }
  }
  return out
}

/** Times of frames whose luma std-dev is under 1, outside the first and last `edge` seconds. */
export const blankTimes = (
  frames: readonly { t: number; std: number }[],
  duration: number,
  edge = 0.3,
): number[] =>
  frames.filter((f) => f.std < 1 && f.t >= edge && f.t <= duration - edge).map((f) => f.t)

/**
 * How long the film holds still at its end: the trailing span of frames (ascending t) whose
 * difference to the previous one is under `still`. `diffs[i]` is between frames i-1 and i.
 */
/**
 * What a reader sees of the layout at t: every text run (id, text, box to the pixel, opacity to a
 * hundredth) and the camera (to 1e-4). Two equal signatures mean nothing a person reads moved,
 * though light, a glint or a watch's seconds hand may.
 */
export const layoutSignature = (runs: readonly TextRun[], camera: unknown): string =>
  JSON.stringify([
    runs.map((r) => [
      r.id,
      r.text,
      r.box.map((n) => Math.round(n)),
      r.opacity === undefined ? 1 : Math.round(r.opacity * 100) / 100,
    ]),
    camera === null || camera === undefined
      ? null
      : JSON.parse(
          JSON.stringify(camera, (_, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v)),
        ),
  ])

export const endHold = (times: readonly number[], diffs: readonly number[], still = 0.5) => {
  let i = times.length - 1
  while (i > 0 && (diffs[i] as number) < still) i--
  return (times[times.length - 1] as number) - (times[i] as number)
}

const isRun = (v: { [k: string]: Json }): boolean =>
  typeof v.text === 'string' &&
  v.visible !== false &&
  v.opacity !== 0 &&
  Array.isArray(v.box) &&
  v.box.length === 4 &&
  v.box.every((n) => typeof n === 'number')

/**
 * Every visible text run (`{ text, box: [x, y, w, h] }`) anywhere in an inspect tree; `font` falls
 * back to `family`. A run with `opacity: 0` or `visible: false` is not shown, so not a run.
 */
export const textRuns = (json: Json, out: TextRun[] = []): TextRun[] => {
  if (json === null || typeof json !== 'object') return out
  if (!Array.isArray(json) && isRun(json as { [k: string]: Json })) {
    const v = json as unknown as TextRun & { id?: string; family?: string }
    out.push({
      id: typeof v.id === 'string' ? v.id : `#${out.length}`,
      role: v.role,
      text: v.text,
      font: typeof v.font === 'string' ? v.font : v.family,
      size: v.size,
      box: v.box,
      ...(typeof v.opacity === 'number' ? { opacity: v.opacity } : {}),
    })
    return out
  }
  for (const v of Object.values(json)) textRuns(v as Json, out)
  return out
}

/** The source's `shots` (top level), `{ id, at }` or `{ id, start, end }`, sorted by time; [] without them. */
export const shotsOf = (json: Json): Shot[] => {
  const shots = (json as { shots?: unknown } | null)?.shots
  if (!Array.isArray(shots)) return []
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const out: Shot[] = []
  for (const s of shots as Record<string, unknown>[]) {
    if (!s || typeof s !== 'object') continue
    const id = typeof s.id === 'string' ? { id: s.id } : {}
    const label = typeof s.label === 'string' ? { label: s.label } : {}
    if (num(s.start) && num(s.end) && s.end > s.start)
      out.push({ ...id, ...label, at: s.start, start: s.start, end: s.end })
    else if (num(s.at)) out.push({ ...id, ...label, at: s.at })
  }
  out.sort((a, b) => a.at - b.at)
  // A span's `at`: the middle of the part the shots either side do not overlap.
  out.forEach((s, i) => {
    if (s.start === undefined || s.end === undefined) return
    const before = out[i - 1]?.end
    const after = out[i + 1]?.start
    const from = before !== undefined && before > s.start ? Math.min(before, s.end) : s.start
    const to = after !== undefined && after < s.end ? Math.max(after, from) : s.end
    s.at = to > from ? (from + to) / 2 : (s.start + s.end) / 2
  })
  return out
}

export type Margins = { top: number; right: number; bottom: number; left: number }

/** A run's margins to the frame edges as fractions of width/height (negative: outside). */
export const margins = (box: TextRun['box'], width: number, height: number): Margins => {
  const [x, y, w, h] = box
  return {
    left: x / width,
    top: y / height,
    right: (width - x - w) / width,
    bottom: (height - y - h) / height,
  }
}

/** Runs outside the frame, or inside the safe area's margins when one is given. */
export const textFit = (
  runs: readonly (TextRun & { t: number })[],
  width: number,
  height: number,
  safe?: Margins,
) => {
  const limit = safe ?? { top: 0, right: 0, bottom: 0, left: 0 }
  let min = Infinity
  const outside: {
    id: string
    t: number
    side: keyof Margins
    margin: number
    box: [number, number, number, number]
  }[] = []
  for (const r of runs) {
    const m = margins(r.box, width, height)
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      min = Math.min(min, m[side])
      if (m[side] < limit[side] - 1e-9)
        outside.push({ id: r.id, t: r.t, side, margin: m[side], box: r.box })
    }
  }
  return { minMargin: Number.isFinite(min) ? min : null, outside }
}

/** Pairs of runs at the same t whose boxes overlap more than `limit` of the smaller box. */
export const textOverlaps = (runs: readonly (TextRun & { t: number })[], limit = 0.1) => {
  const out: {
    a: string
    b: string
    t: number
    fraction: number
    /** The overlap, in frame pixels. */
    box: [number, number, number, number]
  }[] = []
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i] as TextRun & { t: number }
      const b = runs[j] as TextRun & { t: number }
      if (a.t !== b.t || !a.text.trim() || !b.text.trim()) continue
      const w = Math.min(a.box[0] + a.box[2], b.box[0] + b.box[2]) - Math.max(a.box[0], b.box[0])
      const h = Math.min(a.box[1] + a.box[3], b.box[1] + b.box[3]) - Math.max(a.box[1], b.box[1])
      if (w <= 0 || h <= 0) continue
      const smaller = Math.min(a.box[2] * a.box[3], b.box[2] * b.box[3])
      const fraction = smaller > 0 ? (w * h) / smaller : 0
      const x = Math.max(a.box[0], b.box[0])
      const y = Math.max(a.box[1], b.box[1])
      if (fraction > limit) out.push({ a: a.id, b: b.id, t: a.t, fraction, box: [x, y, w, h] })
    }
  }
  return out
}

const normal = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim()

/** The required copy that no run contains verbatim (whitespace normalised). */
export const missingCopy = (required: readonly string[], runs: readonly TextRun[]): string[] => {
  const texts = runs.map((r) => normal(r.text))
  const all = normal(runs.map((r) => r.text).join(' '))
  return required.filter((c) => {
    const n = normal(c)
    return !texts.some((t) => t.includes(n)) && !all.includes(n)
  })
}

const relative = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * WCAG contrast inside a run's box: the 10th and 90th luminance percentiles of its pixels stand in
 * for text and background. Null for an empty box.
 */
export const boxContrast = (frame: Frame, box: TextRun['box']): number | null => {
  const x0 = Math.max(0, Math.floor(box[0]))
  const y0 = Math.max(0, Math.floor(box[1]))
  const x1 = Math.min(frame.width, Math.ceil(box[0] + box[2]))
  const y1 = Math.min(frame.height, Math.ceil(box[1] + box[3]))
  if (x1 <= x0 || y1 <= y0) return null
  const values: number[] = []
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)))
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const k = (y * frame.width + x) * 4
      const p = frame.pixels
      values.push(
        0.2126 * relative(p[k] as number) +
          0.7152 * relative(p[k + 1] as number) +
          0.0722 * relative(p[k + 2] as number),
      )
    }
  }
  values.sort((a, b) => a - b)
  const lo = values[Math.floor(values.length * 0.1)] as number
  const hi = values[Math.floor(values.length * 0.9)] as number
  return (hi + 0.05) / (lo + 0.05)
}

/** The family names in a run's font: a CSS font string's quoted families, or the name itself. */
export const fontFamilies = (font: string): string[] => {
  const quoted = [...font.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string)
  if (quoted.length) return quoted
  const list = font.replace(/^.*?\d+(\.\d+)?px\s+/, '')
  return list
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
}

/** Limits on the subtitle sidecar, as requirements.json `captions` declares them. */
export type CaptionLimits = {
  /** Characters per second: grapheme clusters, spaces included, line breaks not. */
  maxCps?: number
  /** Characters in the longest line, as grapheme clusters. */
  maxLineChars?: number
  maxLines?: number
  /** Seconds on screen. */
  minDuration?: number
  /** Seconds from a caption's end to the next one's start; an overlap is a negative gap. */
  minGap?: number
}

/** One caption measured. */
export type CaptionStat = {
  /**
   * Its cue number in the full-length SRT: the captions every export keeps (not blank, not
   * refused) in order of start, from 1. null for a caption no SRT carries.
   */
  index: number | null
  /** Its place in what `captions()` gave, from 1: how a caption without an SRT number is named. */
  item: number
  start: number
  /** null: no finite end (an LRC cue's last line ends at Infinity). */
  end: number | null
  text: string
  duration: number | null
  cps: number | null
  /** To the next cue by start; negative when they overlap; null for the last, an open end or no cue. */
  gap: number | null
  lines: number
  longestLine: number
  /** The cue numbers (`index`) of the other cues on screen at the same time. */
  overlaps: number[]
  /** Why every export refuses this caption (render and deliver write no sidecar with it). */
  refused?: string
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })

/**
 * Copy as a review quotes it: whitespace collapsed, and past `max` characters cut at the last word
 * boundary that fits, with an ellipsis (Thai, written without spaces, still breaks between words).
 */
export const excerpt = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  let cut = 0
  let first = 0
  for (const { index } of words.segment(flat)) {
    if (first === 0) first = index
    if (index > max - 1) break
    cut = index
  }
  // The first word longer than max: quote it whole, and nothing after it.
  if (cut === 0) cut = first
  if (cut === 0) return flat
  return `${flat.slice(0, cut).replace(/[\s\p{P}]+$/u, '')}…`
}

/** Grapheme clusters: a Thai syllable with its vowel and tone marks counts as what a reader sees. */
const graphemes = (text: string) => [...new Intl.Segmenter().segment(text)].length

/**
 * Each caption's characters per second, duration, gap to the next, line count and longest line
 * (grapheme clusters), and the captions it overlaps, in order of start.
 */
export const captionStats = (captions: readonly unknown[]): CaptionStat[] => {
  const rows = captions.map((raw, index): CaptionStat => {
    const c = (raw ?? {}) as { start?: unknown; end?: unknown; text?: unknown }
    const start = typeof c.start === 'number' && Number.isFinite(c.start) ? c.start : Number.NaN
    const end = typeof c.end === 'number' && Number.isFinite(c.end) ? c.end : null
    const text = typeof c.text === 'string' ? c.text : ''
    const lines = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const duration = end === null || Number.isNaN(start) ? null : end - start
    const chars = graphemes(lines.join(''))
    const refused =
      typeof c.text !== 'string'
        ? 'no text'
        : Number.isNaN(start)
          ? `no start (start: ${String(c.start)})`
          : end === null
            ? `no end (end: ${String(c.end)}${c.end === Number.POSITIVE_INFINITY ? ', as an LRC cue’s last line has' : ''})`
            : end <= start
              ? 'ends before it starts'
              : undefined
    return {
      index: null,
      item: index + 1,
      start,
      end,
      text,
      duration,
      cps: duration !== null && duration > 0 ? chars / duration : null,
      gap: null,
      lines: lines.length,
      longestLine: Math.max(0, ...lines.map(graphemes)),
      overlaps: [],
      ...(refused ? { refused } : {}),
    }
  })
  // Numbered as the SRT writer numbers cues (windowCaptions, toSrt): blank and refused ones dropped,
  // the rest sorted by start, ties kept in captions() order.
  const timed = rows.filter((r) => !Number.isNaN(r.start)).sort((a, b) => a.start - b.start)
  const cues = timed.filter((r) => !r.refused && r.text.trim() !== '')
  for (const [i, a] of cues.entries()) a.index = i + 1
  for (const [i, a] of cues.entries()) {
    const next = cues[i + 1]
    if (next && a.end !== null) a.gap = next.start - a.end
    for (const b of cues)
      if (b !== a && a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity))
        a.overlaps.push(b.index as number)
  }
  return [...timed, ...rows.filter((r) => Number.isNaN(r.start))]
}

/** The cues over a declared limit, each with what it breaks; a caption no SRT carries is not judged. */
export const captionsOver = (stats: readonly CaptionStat[], limits: CaptionLimits) => {
  const r = (n: number) => Number(n.toFixed(3))
  return stats.flatMap((s) => {
    if (s.index === null) return []
    const why: string[] = []
    const { maxCps, maxLineChars, maxLines, minDuration, minGap } = limits
    if (maxCps !== undefined && s.cps !== null && s.cps > maxCps + 1e-6)
      why.push(`${r(s.cps)} cps > ${maxCps}`)
    if (maxLineChars !== undefined && s.longestLine > maxLineChars)
      why.push(`a line of ${s.longestLine} characters > ${maxLineChars}`)
    if (maxLines !== undefined && s.lines > maxLines) why.push(`${s.lines} lines > ${maxLines}`)
    if (minDuration !== undefined && s.duration !== null && s.duration + 1e-6 < minDuration)
      why.push(`${r(s.duration)} s < ${minDuration} s`)
    if (minGap !== undefined && s.gap !== null && s.gap + 1e-6 < minGap)
      why.push(
        s.gap < 0 ? `overlaps the next by ${r(-s.gap)} s` : `gap ${r(s.gap)} s < ${minGap} s`,
      )
    return why.length ? [{ ...s, why }] : []
  })
}
