import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { frameCount } from '@shaderera/core/host'
import { encodePng } from '../deliver/png.ts'
import { videoReader } from '../node/services.ts'
import { activityImage } from '../project/activity.ts'
import { safeName } from '../project/jobs.ts'
import { outputRequirements, readRequirements } from '../project/requirements.ts'
import { type Comparison, compareFrames, sideBySide } from '../review/compare.ts'
import { contactSheet, pngWriter, toPng } from '../review/review.ts'
import { type VariantFrames, variantSheet } from '../review/variant-sheet.ts'
import { insideFilm, open, parseRendering, timesOf } from './args.ts'
import { clockWarning } from './clock.ts'
import { crop, objectRegion, parseRegion, type Region } from './crop.ts'
import { EXIT } from './findings.ts'
import { direct, eachVariant, nameOf, type Output } from './variants.ts'

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
    if (!(to > from)) throw new Error(`--from ${from} is not before --to ${to}.`)
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
      json: { type: 'boolean' },
      variants: { type: 'string' },
    },
    { command: 'still', times: true },
  )
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

/**
 * A rendered file, read as `io.video` reads a clip: its size and length, and the frame shown at
 * each t (the frame whose time is the last at or before t).
 */
export const openFile = (file: string) => {
  const reader = videoReader(file)
  const { width, height, fps, frames } = reader.info
  return {
    width,
    height,
    duration: frames / fps,
    frame: (t: number) => reader.frame(Math.min(frames - 1, Math.floor(t * fps + 1e-6))),
    close: () => reader.dispose(),
  }
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
