import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { frameCount } from '@shaderera/core/host'
import { encodePng } from '../deliver/png.ts'
import { activityImage } from '../project/activity.ts'
import { safeName } from '../project/jobs.ts'
import { outputRequirements, readRequirements } from '../project/requirements.ts'
import { type Comparison, compareFrames, sideBySide } from '../review/compare.ts'
import { contactSheet, pngWriter, toPng } from '../review/review.ts'
import { type VariantFrames, variantSheet } from '../review/variant-sheet.ts'
import { insideFilm, open, parseRendering, timesOf } from './args.ts'
import { clockWarning } from './clock.ts'
import { compareWithFile, frameLine, onSheet, summaryLines } from './compare-file.ts'
import { imageFrameLines, imageSummaryLines, isImage } from './compare-image.ts'
import { crop, objectRegion, parseRegion, type Region } from './crop.ts'
import { EXIT } from './findings.ts'
import { direct, eachVariant, nameOf, type Output } from './variants.ts'
import { openFile } from './video-file.ts'

/** `--count n [--from s] [--to s]`: n times evenly from `from` (0) up to before `to` (the end). */
export type Span = { count: number; from?: number; to?: number }

/**
 * The times to render: the times given, plus every `every` seconds from 0 and `span`'s, when
 * asked. Each must be inside the film.
 */
export const stillTimes = (
  given: readonly number[],
  every: number | undefined,
  duration: number,
  span?: Span,
) => {
  const times = [...given]
  if (every !== undefined) {
    if (!(every > 0)) throw new Error('--every needs seconds above 0.')
    for (let t = 0; t < duration - 1e-9; t += every) times.push(Number(t.toFixed(6)))
  }
  if (span) {
    const { count, from = 0, to = duration } = span
    if (!(Number.isInteger(count) && count >= 1))
      throw new Error(`--count is a whole number of frames, 1 or more, not ${count}.`)
    if (!(to > from)) throw new Error(`--to must be after --from (${from}–${to} s).`)
    for (let i = 0; i < count; i++)
      times.push(Number((from + ((to - from) * i) / count).toFixed(6)))
  }
  if (times.length === 0)
    throw new Error('Usage: shaderera still <t>... [--every s] [--sheet] [--diff] (seconds)')
  insideFilm(times, duration)
  return times
}

/** One still: its file, how long it took, and what was asked of it. */
type Still = {
  t: number
  file: string
  ms: number
  /** `--region` or `--object`: the enlarged part. */
  part?: { file: string; region: Region; scale: number }
  /** `--diff`: channels that differ after a jump. */
  differing?: number
  /** `--compare`: the pair side by side, and what was measured between them. */
  compare?: Comparison & { variant: string; file: string }
}

/** A still as a line: the file and time, then each thing asked of it. */
const lineOf = (s: Still) => {
  const at = (f: string) => relative(process.cwd(), f)
  let line = `${at(s.file)}  ${s.ms.toFixed(0)} ms`
  if (s.part) {
    const r = s.part.region
    line += `\n${at(s.part.file)}  ${r.width}×${r.height} at ${r.x},${r.y}, ×${s.part.scale}`
  }
  if (s.differing !== undefined) line += `  differing channels after a jump: ${s.differing}`
  if (s.compare) {
    const c = s.compare
    const psnr = Number.isFinite(c.psnr) ? `PSNR ${c.psnr.toFixed(2)} dB` : 'identical'
    line += `\n${at(c.file)}  vs ${c.variant}: ${psnr}, mean ΔE ${c.deltaE.toFixed(3)} (max ${c.maxDeltaE.toFixed(2)}), ${c.differing} pixels differ`
  }
  return line
}

/**
 * `shaderera still <t>... [--time t]... [--every s] [--sheet] [--diff] [--param k=v]... [--out dir]
 * [--region x,y,w,h | --object id] [--scale n] [--compare variant] [--json]`
 *
 * Stills of any moment straight from the source, rendered by the same host as `check` and
 * `render`, so a shader that does not compile or a WebGPU error fails the still instead of
 * writing a black frame. `--region` (frame pixels) or `--object` (an inspected object's `bbox`, else a text run's `box`)
 * also writes that part of each still, enlarged `--scale` times by whole pixels: a close look.
 * `--compare <variant>` renders each t in that variant too and writes the pair side by side with
 * PSNR and mean ΔE between them: measured, never judged (decision 0011). `--variant a,b` or
 * `--variants all` renders the same times in each variant, in its own host, at once (eachVariant).
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values, times } = parseRendering(
    argv,
    {
      file: { type: 'string' },
      columns: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      count: { type: 'string' },
      every: { type: 'string' },
      sheet: { type: 'boolean' },
      diff: { type: 'boolean' },
      out: { type: 'string' },
      region: { type: 'string' },
      object: { type: 'string' },
      scale: { type: 'string' },
      compare: { type: 'string' },
      'compare-file': { type: 'string' },
      offset: { type: 'string' },
      'max-shift': { type: 'string' },
      floor: { type: 'string' },
      regions: { type: 'string' },
      fit: { type: 'string' },
      json: { type: 'boolean' },
      variants: { type: 'string' },
    },
    { command: 'still', times: true },
  )
  const against = values['compare-file']
  if (against === undefined)
    for (const flag of ['offset', 'max-shift', 'floor', 'regions', 'fit'] as const)
      if (values[flag] !== undefined)
        throw new Error(
          `--${flag} goes with --compare-file <${flag === 'regions' || flag === 'fit' ? 'image' : 'video'}>: give it too.`,
        )
  if (against !== undefined) {
    for (const flag of ['file', 'compare', 'object', 'diff', 'scale'] as const)
      if (values[flag] !== undefined)
        throw new Error(
          `--${flag} is not for --compare-file, which measures the film against a reference.`,
        )
    return eachVariant(values, (v, out) => stillCompareFile(against, v, times, out), {
      json: values.json === true,
      one: '--compare-file measures one variant against the reference: give one --variant with it.',
    })
  }
  if (values.file !== undefined) return stillFile(values.file, values, times)
  // Several variants with --sheet: each one's frames, for one sheet of them side by side.
  const kept: (VariantFrames & { outDir: string })[] = []
  return eachVariant(values, (v, out) => stillOne(v, times, out, kept), {
    json: values.json === true,
    ...(values.compare !== undefined
      ? { one: '--compare puts one variant beside another: give one --variant with it.' }
      : {}),
    after: async (names) => {
      if (kept.length < 2) return undefined
      const order = names.map(nameOf)
      kept.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
      const file = join(
        (kept[0] as { outDir: string }).outDir,
        `${kept.map((k) => safeName(k.name)).join('-')}-sheet.png`,
      )
      writeFileSync(file, await variantSheet(kept))
      activityImage(file)
      return { line: relative(process.cwd(), file), result: { sheet: file } }
    },
  })
}

/** `--count`, `--from` and `--to` as a Span; --from or --to without --count is refused. */
const spanOf = (v: { count?: string; from?: string; to?: string }): Span | undefined => {
  if (v.count === undefined) {
    if (v.from !== undefined || v.to !== undefined)
      throw new Error('--from and --to go with --count: --count n [--from s] [--to s].')
    return undefined
  }
  const [from, to] = [v.from, v.to].map((x) => (x === undefined ? undefined : timesOf([x])[0]))
  return {
    count: Number(v.count),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  }
}

/** `--columns n`: how many frames across a sheet (4 by default); only with --sheet. */
const columnsOf = (v: { columns?: string; sheet?: boolean }): number => {
  if (v.columns === undefined) return 4
  if (!v.sheet) throw new Error('--columns lays out a --sheet: give --sheet with it.')
  const n = Number(v.columns)
  if (!(Number.isInteger(n) && n >= 1))
    throw new Error(`--columns is a whole number, 1 or more, not ${v.columns}.`)
  return n
}

/** The flags `still --file` refuses: they render the source, which a file is not. */
const SOURCE_ONLY = ['variant', 'variants', 'compare', 'region', 'object', 'diff', 'param'] as const

/** `still --file <video> <t>...`: stills and a sheet of a rendered file, not of the source. */
const stillFile = async (
  file: string,
  v: {
    [k in (typeof SOURCE_ONLY)[number]]?: unknown
  } & {
    every?: string
    count?: string
    from?: string
    to?: string
    sheet?: boolean
    columns?: string
    out?: string
    json?: boolean
  },
  given: readonly number[],
): Promise<number> => {
  for (const flag of SOURCE_ONLY)
    if (v[flag] !== undefined)
      throw new Error(`--${flag} renders the source: still --file reads the file's frames only.`)
  const columns = columnsOf(v)
  const path = resolve(file)
  const video = openFile(path)
  try {
    const { width, height } = video
    const times = stillTimes(
      given,
      v.every === undefined ? undefined : Number(v.every),
      video.duration,
      spanOf(v),
    )
    const name = basename(path, extname(path))
    const outDir = v.out ? resolve(v.out) : join(dirname(path), 'stills')
    mkdirSync(outDir, { recursive: true })
    const pngs = pngWriter()
    const stills: Still[] = []
    const shown: { t: number; label: string; pixels: Uint8Array }[] = []
    for (const t of times) {
      const started = performance.now()
      const pixels = await video.frame(t)
      const s: Still = {
        t,
        file: join(outDir, `${name}-${t.toFixed(3)}.png`),
        ms: performance.now() - started,
      }
      await pngs.write(s.file, toPng(pixels, width, height))
      if (v.sheet) shown.push({ t, label: name, pixels })
      stills.push(s)
      if (!v.json) direct.log(lineOf(s))
    }
    const sheet = v.sheet ? join(outDir, `${name}-sheet.png`) : undefined
    if (sheet) await pngs.write(sheet, contactSheet(shown, width, height, columns))
    await pngs.done()
    if (v.json) direct.result({ stills, ...(sheet ? { sheet } : {}) })
    else if (sheet) direct.log(relative(process.cwd(), sheet))
    return EXIT.ok
  } finally {
    await video.close()
  }
}

/** A number flag, or undefined when not given; throws naming the flag when it is not a number. */
const numberOf = (flag: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n))
    throw new Error(`--${flag} is a number, not ${value}.`)
  return n
}

/**
 * `still --compare-file <video|image>`: the film's final frames measured against a reference
 * clip's at the same times, or against one image at each time (compareWithFile), each time's film,
 * reference and difference (an image's: the SSIM heat map) side by side in
 * `<variant>-vs-<reference>-<t>.png`, and with --sheet a sheet of them. Exit 0 unless an input is
 * bad.
 */
const stillCompareFile = async (
  file: string,
  v: Parameters<typeof open>[0] & {
    every?: string
    count?: string
    from?: string
    to?: string
    sheet?: boolean
    columns?: string
    out?: string
    region?: string
    offset?: string
    'max-shift'?: string
    floor?: string
    regions?: string
    fit?: string
    json?: boolean
  },
  given: readonly number[],
  out: Output,
): Promise<number> => {
  const columns = v.columns === undefined ? 1 : columnsOf(v)
  const reference = resolve(file)
  const { project, child } = await open(v)
  try {
    const { width, height, duration } = project.manifest
    // Times asked for as still takes them; none for the clip's frames over --from–--to.
    const asked = given.length > 0 || v.every !== undefined || v.count !== undefined
    const times = asked
      ? stillTimes(given, v.every === undefined ? undefined : Number(v.every), duration, spanOf(v))
      : []
    const variant = typeof v.variant === 'string' ? v.variant : 'main'
    const outDir = v.out ? resolve(v.out) : join(project.root, 'out', 'stills')
    mkdirSync(outDir, { recursive: true })
    const pair = `${safeName(variant)}-vs-${safeName(basename(reference, extname(reference)))}`
    const pngs = pngWriter()
    const files: string[] = []
    const shown: { t: number; label: string; pixels: Uint8Array }[] = []
    let size = { width, height }
    const label = `${variant} | ${basename(reference)} | ${isImage(reference) ? 'SSIM heat map' : 'difference'}`
    const maxShift = numberOf('max-shift', v['max-shift'])
    const from = asked ? undefined : numberOf('from', v.from)
    const to = asked ? undefined : numberOf('to', v.to)
    const offset = numberOf('offset', v.offset)
    const floor = numberOf('floor', v.floor)
    const report = await compareWithFile({
      reference,
      film: {
        width,
        height,
        duration,
        render: async (t) => (await child.render(t, 'final')).pixels,
      },
      times,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(offset === undefined ? {} : { offset }),
      ...(maxShift === undefined ? {} : { maxShift }),
      ...(floor === undefined ? {} : { floor }),
      ...(v.region ? { region: parseRegion(v.region) } : {}),
      ...(v.regions === undefined ? {} : { regions: resolve(v.regions) }),
      ...(v.fit === undefined ? {} : { fit: v.fit }),
      frame: async (f) => {
        // Times under 0.5 ms apart would share a name at 3 decimals: those get 6.
        let name = join(outDir, `${pair}-${f.t.toFixed(3)}.png`)
        if (files.includes(name)) name = join(outDir, `${pair}-${f.t.toFixed(6)}.png`)
        await pngs.write(name, toPng(f.pixels, f.width, f.height))
        files.push(name)
        size = { width: f.width, height: f.height }
        // Every time has its PNG; the sheet holds at most SHEET_ROWS of them, spread evenly.
        if (v.sheet && onSheet(f.index, f.count)) shown.push({ t: f.t, label, pixels: f.pixels })
      },
    })
    const sheet = v.sheet ? join(outDir, `${pair}-sheet.png`) : undefined
    if (sheet) {
      await pngs.write(sheet, contactSheet(shown, size.width, size.height, columns))
      activityImage(sheet)
    }
    await pngs.done()
    const warning = clockWarning(await child.clock())
    if (warning) out.found({ code: 'clock', severity: 'warning', message: warning })
    if (v.json) {
      // PSNR of identical frames is Infinity, which JSON writes as null.
      const frames = (report.frames as object[]).map((f, i) => ({ ...f, file: files[i] }))
      out.result({ ...report, frames, ...(sheet ? { sheet } : {}) })
      return EXIT.ok
    }
    const at = (i: number) => relative(process.cwd(), files[i] as string)
    let summary: string[]
    if ('method' in report) {
      report.frames.forEach((f, i) => {
        const [whole, ...regions] = imageFrameLines(f)
        out.log(`${at(i)}  ${whole}`)
        for (const line of regions) out.log(line)
      })
      summary = imageSummaryLines(report)
    } else {
      report.frames.forEach((f, i) => {
        out.log(`${at(i)}  ${frameLine(f)}`)
      })
      summary = summaryLines(report)
    }
    if (sheet) out.log(relative(process.cwd(), sheet))
    for (const line of summary) out.log(line)
    if (warning) out.log(`! ${warning}`)
    return EXIT.ok
  } finally {
    await child.close()
  }
}

const stillOne = async (
  v: Parameters<typeof open>[0] & {
    every?: string
    count?: string
    from?: string
    to?: string
    sheet?: boolean
    columns?: string
    diff?: boolean
    out?: string
    region?: string
    object?: string
    scale?: string
    compare?: string
    json?: boolean
  },
  given: readonly number[],
  out: Output,
  kept: (VariantFrames & { outDir: string })[],
): Promise<number> => {
  if (v.region && v.object) throw new Error('Give --region or --object, not both.')
  const columns = columnsOf(v)
  const scale = v.scale === undefined ? 1 : Number(v.scale)
  const variant = typeof v.variant === 'string' ? v.variant : 'main'
  if (v.compare === variant)
    throw new Error(`--compare ${variant} is the variant rendered already.`)
  const { project, child } = await open(v)
  let other: Awaited<ReturnType<typeof open>> | undefined
  try {
    // The other variant, with the same params given: what differs is what the variants design.
    // `main` is the manifest's own output, as still names its files.
    if (v.compare !== undefined)
      other = await open({ ...v, variant: v.compare === 'main' ? undefined : v.compare })
    const { width, height, duration, fps } = project.manifest
    if (other) {
      const o = other.project.manifest
      if (o.width !== width || o.height !== height)
        throw new Error(
          `${v.compare} is ${o.width}×${o.height} and ${variant} ${width}×${height}: --compare needs one frame size.`,
        )
    }
    const times = stillTimes(
      given,
      v.every === undefined ? undefined : Number(v.every),
      Math.min(duration, other?.project.manifest.duration ?? duration),
      spanOf(v),
    )
    const outDir = v.out ? resolve(v.out) : join(project.root, 'out', 'stills')
    mkdirSync(outDir, { recursive: true })
    const last = frameCount(fps, duration) - 1
    const name = safeName(variant)
    const pair = other ? `${name}-vs-${safeName(v.compare as string)}` : name
    const sheetWidth = other ? width * 2 : width
    const rendered: { t: number; label: string; pixels: Uint8Array }[] = []
    const stills: Still[] = []
    const frames: { t: number; pixels: Uint8Array }[] = []
    let history = 0
    const pngs = pngWriter()
    for (const t of times) {
      const started = performance.now()
      const { pixels } = await child.render(t, 'final')
      const ms = performance.now() - started
      const s: Still = { t, file: join(outDir, `${name}-${t.toFixed(3)}.png`), ms }
      await pngs.write(s.file, toPng(pixels, width, height))
      const region: Region | undefined = v.region
        ? parseRegion(v.region)
        : v.object
          ? objectRegion(await child.inspect(t), v.object)
          : undefined
      if (region) {
        const c = crop(pixels, { width, height }, region, scale)
        const r = c.region
        const file = join(
          outDir,
          `${name}-${t.toFixed(3)}-${r.x}_${r.y}_${r.width}x${r.height}@${scale}.png`,
        )
        writeFileSync(file, encodePng(c.pixels, c.width, c.height))
        s.part = { file, region: r, scale }
      }
      if (v.diff) {
        // A far-away frame first: a frame that depends on history comes back different.
        const away = Math.round(t * fps) > last / 2 ? 0 : last / fps
        await child.render(away, 'final')
        const again = (await child.render(t, 'final')).pixels
        let n = 0
        for (let i = 0; i < pixels.length; i++) if (pixels[i] !== again[i]) n++
        s.differing = n
        if (n > 0) {
          history++
          out.found({
            code: 'history',
            severity: 'error',
            message: `${n} channels differ after a jump: the frame depends on history`,
            t: [t],
          })
        }
      }
      let shown: Uint8Array = pixels
      if (other) {
        const theirs = (await other.child.render(t, 'final')).pixels
        shown = sideBySide(pixels, theirs, width, height)
        const file = join(outDir, `${pair}-${t.toFixed(3)}.png`)
        await pngs.write(file, toPng(shown, sheetWidth, height))
        s.compare = { variant: v.compare as string, file, ...compareFrames(pixels, theirs) }
      }
      // Kept only for the sheet: `--every` over a long film would hold every frame in memory.
      if (v.sheet && !out.several) rendered.push({ t, label: pair, pixels: shown })
      if (v.sheet && out.several) frames.push({ t, pixels })
      stills.push(s)
      if (!v.json) out.log(lineOf(s))
    }
    let sheet: string | undefined
    // Several variants: one sheet of them side by side instead (run, after).
    if (v.sheet && out.several) {
      const { safeArea } = outputRequirements(readRequirements(project.root), {
        ...(variant === 'main' ? {} : { variant }),
        ...project.manifest,
      })
      kept.push({ name: variant, width, height, ...(safeArea ? { safeArea } : {}), frames, outDir })
    } else if (v.sheet) {
      sheet = join(outDir, `${pair}-sheet.png`)
      await pngs.write(sheet, contactSheet(rendered, sheetWidth, height, columns))
      activityImage(sheet)
    }
    await pngs.done()
    if (sheet && !v.json) out.log(relative(process.cwd(), sheet))
    const warning = clockWarning(await child.clock())
    if (warning) {
      if (!v.json) out.log(`! ${warning}`)
      out.found({ code: 'clock', severity: 'warning', message: warning })
    }
    // PSNR of identical frames is Infinity, which JSON writes as null.
    if (v.json) out.result({ stills, ...(sheet ? { sheet } : {}) })
    else if (history > 0)
      out.log(`${history} frame(s) depend on history: export will refuse them (shaderera check).`)
    return history > 0 ? EXIT.failed : EXIT.ok
  } finally {
    await Promise.all([child.close(), other?.child.close()])
  }
}
