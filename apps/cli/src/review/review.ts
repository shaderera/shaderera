// One review of a project: principal frames, a contact sheet and technical checks. The CLI and MCP
// both call this; each opens the child (for a variant or a frozen revision) itself.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { Json } from '@shaderera/core'
import { frameCount } from '@shaderera/core/host'
import { checkChild } from '../cli/check.ts'
import { clipFiles, type Loudness, mixLoudness } from '../cli/ffmpeg.ts'
import type { Child } from '../node/child.ts'
import type { Project } from '../node/project.ts'
import type { Requirements } from '../project/requirements.ts'
import { cmapCodePoints, missingGlyphs } from './cmap.ts'
import {
  blankTimes,
  boxContrast,
  endHold,
  fontFamilies,
  frameStats,
  layoutSignature,
  lumaGrid,
  meanAbsDiff,
  missingCopy,
  type Shot,
  shotsOf,
  type TextRun,
  textFit,
  textOverlaps,
  textRuns,
} from './measure.ts'
import { evaluateTimings } from './timing.ts'

/** Mean luma difference above which two widths of one frame mean sheared read-back rows. */
const READBACK_LIMIT = 8
export type Check = {
  id: string
  title: string
  /**
   * `info`: measured, with nothing declared to judge it against. Craft rules (an end hold, a
   * reading time, a safe area, text overlap, blank frames) are judged only when requirements.json
   * declares them (decision 0011).
   */
  status: 'pass' | 'fail' | 'unknown' | 'info'
  measured?: string
  detail?: string
  at?: number[]
  /** Where in the frame, for a check about text: the run (or the overlap), its t and box in pixels. */
  where?: { id: string; t: number; box: [number, number, number, number] }[]
}

export type ReviewFrame = { t: number; label: string; file: string; thumb: string }

export type ReviewReport = {
  version: 1
  manifest: { width: number; height: number; fps: number; duration: number }
  frames: ReviewFrame[]
  contactSheet: string
  checks: Check[]
  diagnostics: {
    exposure: { t: number; meanLuma: number; clipped: number; crushed: number }[]
    contrast: { id: string; t: number; ratio: number | null }[]
    motion: { samples: number; staticPercent: number | null }
    alpha: { nonOpaque: number }
    /** The clips, how much of the film they cover, and their mix's loudness (EBU R128). */
    audio: { clips: number; coverage: number; loudness: Loudness | null } | null
  }
  elapsedMs: number
}

export type ReviewOptions = {
  project: Project
  child: Child
  outDir: string
  requirements?: Requirements
  quick?: boolean
  /** Frame times to render instead of the shots. */
  times?: number[]
  /** Opens the same source at another size, for the readback check; without it, `unknown`. */
  reopen?: (size: { width: number; height: number }) => Promise<Child>
}

const THUMB = 1600
const round = (n: number, d = 3) => Number(n.toFixed(d))

/** RGBA pixels as a PNG, scaled down to fit `max` pixels on the long side. */
export const toPng = (px: Uint8Array, width: number, height: number, max = Infinity): Buffer => {
  const ctx = createCanvas(width, height).getContext('2d')
  const image = ctx.createImageData(width, height)
  image.data.set(px)
  ctx.putImageData(image, 0, 0)
  const scale = Math.min(1, max / Math.max(width, height))
  if (scale === 1) return ctx.canvas.toBuffer('image/png')
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const small = createCanvas(w, h).getContext('2d')
  small.drawImage(ctx.canvas, 0, 0, w, h)
  return small.canvas.toBuffer('image/png')
}

/** A grid of frames, each labelled with its t and shot label underneath. */
export const contactSheet = (
  frames: readonly { t: number; label: string; pixels: Uint8Array }[],
  width: number,
  height: number,
): Buffer => {
  const cols = Math.min(4, Math.max(1, frames.length))
  const rows = Math.ceil(frames.length / cols)
  const tileW = Math.min(width, Math.floor((THUMB - 8 * (cols + 1)) / cols))
  const tileH = Math.round((height * tileW) / width)
  const label = 22
  const pad = 8
  const sheet = createCanvas(
    pad + cols * (tileW + pad),
    pad + rows * (tileH + label + pad),
  ).getContext('2d')
  sheet.fillStyle = '#16181c'
  sheet.fillRect(0, 0, sheet.canvas.width, sheet.canvas.height)
  const full = createCanvas(width, height).getContext('2d')
  frames.forEach((f, i) => {
    const x = pad + (i % cols) * (tileW + pad)
    const y = pad + Math.floor(i / cols) * (tileH + label + pad)
    const image = full.createImageData(width, height)
    image.data.set(f.pixels)
    full.clearRect(0, 0, width, height)
    full.putImageData(image, 0, 0)
    // A checkerboard shows transparency.
    sheet.fillStyle = '#3a3d44'
    sheet.fillRect(x, y, tileW, tileH)
    sheet.drawImage(full.canvas, x, y, tileW, tileH)
    sheet.fillStyle = '#e6e8ec'
    sheet.font = '14px sans-serif'
    const text = `${f.t.toFixed(2)} s  ${f.label}`
    let shown = text
    while (shown.length > 4 && sheet.measureText(shown).width > tileW) shown = shown.slice(0, -2)
    sheet.fillText(shown === text ? text : `${shown}…`, x, y + tileH + 16)
  })
  return sheet.canvas.toBuffer('image/png')
}

/**
 * How long each text is on screen: the longest stretch of 0.25 s samples in which the same text
 * (by id) is visible (opacity ≥ 0.5), with its character count.
 */
export const readingTimes = (runs: (TextRun & { t: number })[], sampleT: number[]) => {
  const step = 0.25
  const sampled = new Set(sampleT)
  const seen = new Map<string, number[]>()
  for (const r of runs)
    if (sampled.has(r.t) && (r.opacity ?? 1) >= 0.5 && r.text.trim()) {
      const key = `${r.id}\u0000${r.text}`
      seen.set(key, [...(seen.get(key) ?? []), r.t])
    }
  const chars = (text: string) => [...new Intl.Segmenter().segment(text.replace(/\s+/g, ''))].length
  const shown: { id: string; text: string; shown: number; chars: number }[] = []
  for (const [key, times] of seen) {
    const [id, text] = key.split('\u0000') as [string, string]
    const ts = [...new Set(times)].sort((a, b) => a - b)
    let best = 0
    for (let i = 0, start = 0; i < ts.length; i++) {
      if (i > 0 && (ts[i] as number) - (ts[i - 1] as number) > step + 1e-6) start = i
      best = Math.max(best, (ts[i] as number) - (ts[start] as number) + step)
    }
    shown.push({ id, text, shown: round(best, 2), chars: chars(text) })
  }
  return shown
}

/** Texts on screen for less than a declared reading time: max(min, characters / charsPerSecond). */
export const readingShort = (
  runs: (TextRun & { t: number })[],
  sampleT: number[],
  rule: { min: number; charsPerSecond: number },
) =>
  readingTimes(runs, sampleT).flatMap((r) => {
    const need = Math.max(rule.min, r.chars / rule.charsPerSecond)
    return r.shown + 1e-6 < need
      ? [{ id: r.id, text: r.text, shown: r.shown, need: round(need, 2) }]
      : []
  })

/** A check's status: judged when its rule is declared, otherwise only measured. */
const judged = (declared: boolean, failing: boolean): Check['status'] =>
  declared ? (failing ? 'fail' : 'pass') : 'info'

/** Frame times (snapped to frames) and labels: shots, midpoints between them and the last frame. */

/** CSS generic families: naming one accepts whatever font the system picks. */
const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])

export const reviewTimes = (
  shots: readonly Shot[],
  fps: number,
  duration: number,
): { t: number; label: string }[] => {
  const frames = Math.max(1, frameCount(fps, duration))
  const snap = (t: number) => Math.min(frames - 1, Math.max(0, Math.round(t * fps))) / fps
  const last = (frames - 1) / fps
  const out: { t: number; label: string }[] = []
  if (shots.length > 0) {
    shots.forEach((s, i) => {
      out.push({ t: snap(s.at), label: s.label ?? s.id ?? `shot ${i + 1}` })
      const next = shots[i + 1]
      if (next) out.push({ t: snap((s.at + next.at) / 2), label: 'transition' })
    })
  } else {
    for (let i = 0; i < 7; i++) out.push({ t: snap((i * duration) / 7), label: `${i + 1}/7` })
  }
  out.push({ t: last, label: 'last frame' })
  const seen = new Set<number>()
  return out.filter((f) => !seen.has(f.t) && seen.add(f.t))
}

export const review = async (o: ReviewOptions): Promise<ReviewReport> => {
  const start = performance.now()
  const { child, requirements: req = { version: 1 } } = o
  const { width, height, fps, duration } = o.project.manifest
  const count = Math.max(1, frameCount(fps, duration))
  const last = (count - 1) / fps
  const snap = (t: number) => Math.min(count - 1, Math.max(0, Math.round(t * fps))) / fps
  mkdirSync(o.outDir, { recursive: true })
  const checks: Check[] = []

  const inspected = new Map<number, Json | null>()
  const inspect = async (t: number) => {
    if (!child.has.inspect) return null
    if (!inspected.has(t)) inspected.set(t, await child.inspect(t))
    return inspected.get(t) ?? null
  }
  const shots = shotsOf(await inspect(0))

  // Principal frames.
  const picked = o.times
    ? o.times.map((t) => ({ t: snap(t), label: '' }))
    : reviewTimes(shots, fps, duration)
  const frames: ReviewFrame[] = []
  const rendered: { t: number; label: string; pixels: Uint8Array }[] = []
  for (const [i, f] of picked.entries()) {
    const { pixels } = await child.render(f.t, 'final')
    const name = `${String(i).padStart(2, '0')}-${f.t.toFixed(2)}s`
    const file = join(o.outDir, `${name}.png`)
    const thumb = join(o.outDir, `${name}.thumb.png`)
    writeFileSync(file, toPng(pixels, width, height))
    writeFileSync(thumb, toPng(pixels, width, height, THUMB))
    frames.push({ t: f.t, label: f.label, file, thumb })
    rendered.push({ ...f, pixels })
  }
  const contactSheetFile = join(o.outDir, 'contact-sheet.png')
  writeFileSync(contactSheetFile, contactSheet(rendered, width, height))

  // format
  const want = req.format ?? {}
  const keys = (['width', 'height', 'fps', 'duration'] as const).filter(
    (k) => want[k] !== undefined,
  )
  const actual = { width, height, fps, duration }
  const measuredFormat = `${width}×${height} at ${fps} fps, ${duration} s`
  const wrong = keys.filter((k) => Math.abs((want[k] as number) - actual[k]) > 1e-6)
  checks.push(
    keys.length === 0
      ? {
          id: 'format',
          title: 'format',
          status: 'unknown',
          measured: measuredFormat,
          detail: 'no format in requirements',
        }
      : {
          id: 'format',
          title: 'format',
          status: wrong.length ? 'fail' : 'pass',
          measured: measuredFormat,
          detail: wrong.length
            ? wrong.map((k) => `${k} ${actual[k]} ≠ ${want[k]}`).join(', ')
            : undefined,
        },
  )

  // determinism
  if (o.quick) {
    checks.push({
      id: 'determinism',
      title: 'determinism',
      status: 'unknown',
      detail: 'skipped (quick)',
    })
  } else {
    const r = await checkChild(child, o.project.manifest, { times: 6 })
    const at = [...new Set(r.failures.map((f) => f.t))]
    checks.push({
      id: 'determinism',
      title: 'determinism',
      status: at.length ? 'fail' : 'pass',
      measured: `${at.length} of ${r.times.length} t differ in two orders (${r.what})`,
      at: at.length ? at : undefined,
    })
  }

  // Samples every 0.25 s (preview) for blank frames, motion and text.
  const sampleT = [
    ...new Set(Array.from({ length: Math.floor(last / 0.25) + 1 }, (_, i) => snap(i * 0.25))),
  ]
  if (!sampleT.includes(last)) sampleT.push(last)
  const samples: { t: number; std: number; diff: number | null }[] = []
  let prev: Uint8Array | null = null
  for (const t of sampleT) {
    const { pixels } = await child.render(t, 'preview')
    samples.push({ t, std: frameStats(pixels).std, diff: prev ? meanAbsDiff(prev, pixels) : null })
    prev = pixels
  }
  const blank = blankTimes(samples, duration)
  checks.push({
    id: 'blank-frames',
    title: 'blank frames',
    status: judged(req.noBlankFrames === true, blank.length > 0),
    measured: `${blank.length} of ${samples.length} samples (every 0.25 s) flat (luma std-dev < 1) outside the first and last 0.3 s`,
    at: blank.length ? blank : undefined,
  })

  // end-hold: 10 fps over the last 3 s.
  const holdT: number[] = []
  for (let t = Math.max(0, last - 3); t <= last + 1e-9; t += 0.1) holdT.push(snap(t))
  const holdTimes = [...new Set([...holdT, last])].sort((a, b) => a - b)
  // Held means a reader's view is still: every pixel, or else the text and the camera (light, a
  // glint or a watch's seconds hand may keep moving on a held end card).
  const diffs: number[] = [0]
  const layout: number[] = [0]
  let before: Uint8Array | null = null
  let signature: string | null = null
  for (const t of holdTimes) {
    const { pixels } = await child.render(t, 'final')
    if (before) diffs.push(meanAbsDiff(before, pixels))
    before = pixels
    if (child.has.inspect) {
      const now = layoutSignature(
        textRuns(await inspect(t)),
        child.has.camera ? await child.camera(t) : null,
      )
      if (signature !== null) layout.push(now === signature ? 0 : 1)
      signature = now
    }
  }
  const stillPixels = endHold(holdTimes, diffs)
  const stillLayout = child.has.inspect ? endHold(holdTimes, layout) : 0
  const hold = Math.max(stillPixels, stillLayout)
  const needHold = req.endHold
  const span = last - (holdTimes[0] as number) - 1e-9
  const say = (s: number) => `${s >= span ? '≥ ' : ''}${round(s, 2)} s`
  checks.push({
    id: 'end-hold',
    title: 'end hold',
    status: judged(needHold !== undefined, hold + 1e-6 < (needHold ?? 0)),
    measured: `${say(hold)} held at the end${needHold === undefined ? '' : ` (need ${needHold} s)`}: pixels still ${say(stillPixels)}${child.has.inspect ? `, text and camera still ${say(stillLayout)}` : ''}`,
  })

  // Text, at every sampled and principal t.
  const textT = [...new Set([...sampleT, ...picked.map((p) => p.t)])].sort((a, b) => a - b)
  // What the source reports through inspect, and the DOM text the host measured itself.
  const runs: (TextRun & { t: number })[] = []
  for (const t of textT) {
    if (child.has.inspect) for (const r of textRuns(await inspect(t))) runs.push({ ...r, t })
    for (const r of await child.text(t)) runs.push({ ...r, t })
  }
  const noText =
    runs.length > 0
      ? undefined
      : child.has.inspect
        ? 'neither inspect nor the DOM shows text'
        : 'the source has no inspect(t) and no DOM text'

  // reading: each text stays visible long enough to read, from the 0.25 s samples.
  if (noText)
    checks.push({ id: 'reading', title: 'reading time', status: 'unknown', detail: noText })
  else {
    const rule = req.readingTime
    if (rule) {
      const short = readingShort(runs, sampleT, rule)
      checks.push({
        id: 'reading',
        title: 'reading time',
        status: short.length ? 'fail' : 'pass',
        measured: `${short.length} texts shown for less than their reading time (sampled every 0.25 s; need max(${rule.min} s, characters / ${rule.charsPerSecond} per s))`,
        detail: short.length
          ? short
              .map((r) => `${r.id} "${r.text.slice(0, 40)}": ${r.shown} s, need ${r.need} s`)
              .join('; ')
          : undefined,
      })
    } else {
      const shortest = readingTimes(runs, sampleT).sort((a, b) => a.shown - b.shown)[0]
      checks.push({
        id: 'reading',
        title: 'reading time',
        status: 'info',
        measured: shortest
          ? `shortest on screen: ${shortest.shown} s, ${shortest.id} "${shortest.text.slice(0, 40)}" (sampled every 0.25 s)`
          : 'no visible text at the samples',
      })
    }
  }

  // text-fit
  if (noText) checks.push({ id: 'text-fit', title: 'text fit', status: 'unknown', detail: noText })
  else {
    const fit = textFit(runs, width, height, req.safeArea)
    const ids = [...new Set(fit.outside.map((f) => `${f.id} (${f.side})`))]
    const minimum = `min margin ${round((fit.minMargin ?? 0) * 100, 1)} %`
    const inFrame = textFit(runs, width, height)
    checks.push({
      id: 'text-fit',
      title: req.safeArea ? 'text inside safe area' : 'text inside frame',
      // Judged against a declared safe area, or the frame when exact copy must be readable.
      status: judged(!!req.safeArea || !!req.copy?.length, fit.outside.length > 0),
      measured: `${new Set(runs.map((r) => r.id)).size} runs at ${textT.length} t, ${minimum}`,
      detail: fit.outside.length
        ? ids.slice(0, 8).join(', ')
        : req.safeArea
          ? undefined
          : `no safe area in requirements; ${inFrame.outside.length} outside the frame`,
      at: fit.outside.length ? [...new Set(fit.outside.map((f) => f.t))] : undefined,
      where: fit.outside.length
        ? fit.outside.map((f) => ({ id: `${f.id} (${f.side})`, t: f.t, box: f.box }))
        : undefined,
    })
  }

  // text-overlap
  if (noText)
    checks.push({ id: 'text-overlap', title: 'text overlap', status: 'unknown', detail: noText })
  else {
    const limit = req.textOverlap
    const overlaps = textOverlaps(runs, limit ?? 0)
    const pairs = [...new Set(overlaps.map((p) => `${p.a} × ${p.b}`))]
    const largest = Math.max(0, ...overlaps.map((p) => p.fraction))
    checks.push({
      id: 'text-overlap',
      title: 'text overlap',
      status: judged(limit !== undefined, overlaps.length > 0),
      measured:
        limit === undefined
          ? `${pairs.length} pairs overlap, the largest ${round(largest * 100, 1)} % of the smaller box`
          : `${pairs.length} pairs overlap > ${round(limit * 100, 1)} % of the smaller box`,
      detail: pairs.length ? pairs.slice(0, 8).join(', ') : undefined,
      at: overlaps.length ? [...new Set(overlaps.map((p) => p.t))] : undefined,
      where: overlaps.length
        ? overlaps.map((p) => ({ id: `${p.a} × ${p.b}`, t: p.t, box: p.box }))
        : undefined,
    })
  }

  // glyphs and assets: what the host registered and what failed.
  const host = await child.fonts()
  if (noText)
    checks.push({ id: 'glyphs', title: 'glyph coverage', status: 'unknown', detail: noText })
  else {
    const cmaps = new Map<string, Set<number>>()
    for (const f of host.fonts) {
      try {
        const set = cmapCodePoints(new Uint8Array(readFileSync(f.path)))
        const prior = cmaps.get(f.family.toLowerCase())
        cmaps.set(f.family.toLowerCase(), prior ? new Set([...prior, ...set]) : set)
      } catch {}
    }
    const missing = new Map<string, Set<string>>()
    const unresolved = new Set<string>()
    /** DOM runs a system font drew that the run's font-family did not name: the named font lacks glyphs. */
    const fellBack = new Map<string, Set<string>>()
    for (const r of runs) {
      if (r.rendered) {
        const named = fontFamilies(r.font ?? '')
          .map((f) => f.toLowerCase())
          .filter((f) => !GENERIC.has(f))
        for (const f of r.rendered)
          if (named.length && !f.custom && f.glyphs > 0 && !named.includes(f.family.toLowerCase()))
            fellBack.set(r.id, (fellBack.get(r.id) ?? new Set()).add(f.family))
        continue
      }
      const sets = r.font
        ? fontFamilies(r.font).flatMap((f) => cmaps.get(f.toLowerCase()) ?? [])
        : []
      const set =
        sets.length === 1 ? sets[0] : sets.length ? new Set(sets.flatMap((x) => [...x])) : undefined
      if (!set) {
        unresolved.add(r.font ?? '(no font)')
        continue
      }
      const m = missingGlyphs(r.text, set)
      if (m.length) {
        const s = missing.get(r.id) ?? new Set()
        for (const c of m) s.add(c)
        missing.set(r.id, s)
      }
    }
    const status = missing.size || fellBack.size ? 'fail' : unresolved.size ? 'unknown' : 'pass'
    checks.push({
      id: 'glyphs',
      title: 'glyph coverage',
      status,
      measured: `${missing.size + fellBack.size} runs miss glyphs; ${cmaps.size} fonts read from io.font; ${runs.filter((r) => r.rendered).length} DOM runs checked by the fonts that drew them`,
      detail:
        [
          ...[...missing].map(
            ([id, s]) =>
              `${id}: ${[...s].map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase()}`).join(' ')}`,
          ),
          ...[...fellBack].map(
            ([id, f]) =>
              `${id}: drawn partly in ${[...f].join(', ')}, which its font-family does not name`,
          ),
          unresolved.size ? `not registered through io.font: ${[...unresolved].join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; ') || undefined,
    })
  }

  // copy
  const copy = (req.copy ?? []).map((c) => c.text)
  if (copy.length === 0)
    checks.push({ id: 'copy', title: 'copy', status: 'unknown', detail: 'no copy in requirements' })
  else if (noText) checks.push({ id: 'copy', title: 'copy', status: 'unknown', detail: noText })
  else {
    const missingC = missingCopy(copy, runs)
    checks.push({
      id: 'copy',
      title: 'copy',
      status: missingC.length ? 'fail' : 'pass',
      measured: `${copy.length - missingC.length} of ${copy.length} required texts found verbatim`,
      detail: missingC.length ? missingC.map((c) => JSON.stringify(c)).join(', ') : undefined,
    })
  }

  // textless: declared by the manifest or variant; then text on screen fails it.
  if (o.project.manifest.textless) {
    const shown = runs.filter((r) => r.text.trim() && (r.opacity ?? 1) >= 0.5)
    checks.push({
      id: 'textless',
      title: 'textless',
      status: shown.length ? 'fail' : noText && !child.has.inspect ? 'unknown' : 'pass',
      measured: shown.length
        ? `${new Set(shown.map((r) => r.id)).size} text runs on screen`
        : `no text in inspect or the DOM at ${textT.length} t (text drawn without either cannot be seen)`,
      ...(shown.length
        ? {
            detail: [...new Set(shown.map((r) => `${r.id} "${r.text.slice(0, 30)}"`))]
              .slice(0, 8)
              .join(', '),
            at: [...new Set(shown.map((r) => r.t))],
            where: shown.slice(0, 50).map((r) => ({ id: r.id, t: r.t, box: r.box })),
          }
        : {}),
    })
  }

  // timing: only what the author declared (decision 0011).
  if (req.timing?.length) {
    if (!child.has.inspect)
      checks.push({
        id: 'timing',
        title: 'timing',
        status: 'unknown',
        detail: 'requirements.json declares timings, but the source has no inspect(t)',
      })
    else {
      const results = await evaluateTimings(req.timing, (t) => child.inspect(t), o.project.manifest)
      const failing = results.filter((r) => !r.ok)
      checks.push({
        id: 'timing',
        title: 'timing',
        status: failing.length ? 'fail' : 'pass',
        measured: `${results.length - failing.length} of ${results.length} declared timings hold`,
        detail: failing.length
          ? failing
              .slice(0, 6)
              .map((r) => `${r.timing.note ?? r.timing.path}: ${r.detail}`)
              .join('; ')
          : undefined,
        at: failing.length ? [...new Set(failing.flatMap((r) => r.t))].slice(0, 50) : undefined,
      })
    }
  }

  checks.push({
    id: 'assets',
    title: 'assets',
    status: host.failures.length ? 'fail' : 'pass',
    measured: `${host.failures.length} failed io.read/io.font calls; ${host.fonts.length} fonts loaded`,
    detail: host.failures.length
      ? host.failures.map((f) => `${f.call} ${f.path}: ${f.error}`).join('; ')
      : undefined,
  })

  // readback
  if (o.quick)
    checks.push({ id: 'readback', title: 'readback', status: 'unknown', detail: 'skipped (quick)' })
  else if ((width * 4) % 256 === 0)
    checks.push({
      id: 'readback',
      title: 'readback',
      status: 'pass',
      measured: `row of ${width * 4} bytes is 256-aligned`,
    })
  else if (!o.reopen)
    checks.push({
      id: 'readback',
      title: 'readback',
      status: 'unknown',
      detail: 'no way to open the source at an aligned width',
    })
  else {
    const hero =
      shots.find((s) => /hero/i.test(`${s.id} ${s.label}`)) ?? shots[Math.floor(shots.length / 2)]
    const t = snap(hero?.at ?? duration / 2)
    const aligned = Math.ceil(width / 64) * 64
    const other = await o.reopen({ width: aligned, height })
    try {
      const a = (await child.render(t, 'final')).pixels
      const b = (await other.render(t, 'final')).pixels
      const gw = Math.max(1, Math.round(width / 10))
      const gh = Math.max(1, Math.round(height / 10))
      const ga = lumaGrid(a, width, height, gw, gh)
      const gb = lumaGrid(b, aligned, height, gw, gh)
      let sum = 0
      for (let k = 0; k < ga.length; k++) sum += Math.abs((ga[k] as number) - (gb[k] as number))
      const mean = sum / ga.length
      // Sheared rows drift a few pixels per row and scramble the frame (Meridian read 18.8);
      // the 0.7 % reframing between the two widths alone stays under about 4.5.
      checks.push({
        id: 'readback',
        title: 'readback',
        status: mean > READBACK_LIMIT ? 'fail' : 'pass',
        measured: `mean luma diff ${round(mean, 2)} on a ${gw}×${gh} grid, ${width} vs ${aligned} px wide at t=${t} (limit ${READBACK_LIMIT})`,
        at: [t],
      })
    } finally {
      await other.close()
    }
  }

  // alpha
  const nonOpaque = Math.max(...rendered.map((r) => frameStats(r.pixels).nonOpaque))
  checks.push({
    id: 'alpha',
    title: 'alpha',
    status: nonOpaque === 0 ? 'pass' : 'unknown',
    measured: `${round(nonOpaque * 100, 2)} % non-opaque pixels (worst principal frame)`,
    detail: nonOpaque === 0 ? undefined : 'diagnostic: no requirement says the output is opaque',
  })

  // Diagnostics.
  const exposure = rendered.map((r) => {
    const s = frameStats(r.pixels)
    return {
      t: r.t,
      meanLuma: round(s.mean, 1),
      clipped: round(s.clipped, 2),
      crushed: round(s.crushed, 2),
    }
  })
  const contrast: ReviewReport['diagnostics']['contrast'] = []
  for (const r of rendered) {
    for (const run of runs.filter((x) => x.t === r.t && x.text.trim())) {
      const ratio = boxContrast({ t: r.t, pixels: r.pixels, width, height }, run.box)
      contrast.push({ id: run.id, t: r.t, ratio: ratio === null ? null : round(ratio, 2) })
    }
  }
  const moved = samples.filter((s) => s.diff !== null)
  const clips = await child.audio()
  let audio: ReviewReport['diagnostics']['audio'] = null
  if (clips) {
    const spans = clips
      .map((c) => [c.at, c.to !== undefined ? c.at + c.to - (c.from ?? 0) : duration] as const)
      .sort((a, b) => a[0] - b[0])
    let covered = 0
    let end = 0
    for (const [a, b] of spans) {
      const s = Math.max(a, end)
      const e = Math.min(b, duration)
      if (e > s) covered += e - s
      end = Math.max(end, b)
    }
    // Measured, never judged: a loudness target is the placement's, declared where it applies.
    let loudness: Loudness | null = null
    const files = clipFiles(o.project.root, clips)
    try {
      loudness = mixLoudness(files.clips, 0, duration)
    } catch {
      // No ffmpeg, or a clip it cannot read: the audio check of render and deliver says so.
    } finally {
      files.cleanup()
    }
    audio = { clips: clips.length, coverage: round(covered / duration, 3), loudness }
  }

  return {
    version: 1,
    manifest: { width, height, fps, duration },
    frames,
    contactSheet: contactSheetFile,
    checks,
    diagnostics: {
      exposure,
      contrast,
      motion: {
        samples: samples.length,
        staticPercent: moved.length
          ? round((100 * moved.filter((s) => (s.diff as number) < 0.5).length) / moved.length, 1)
          : null,
      },
      alpha: { nonOpaque: round(nonOpaque, 4) },
      audio,
    },
    elapsedMs: Math.round(performance.now() - start),
  }
}
