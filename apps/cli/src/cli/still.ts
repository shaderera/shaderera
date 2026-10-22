import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { frameCount } from '@shaderera/core/host'
import { encodePng } from '../deliver/png.ts'
import { safeName } from '../project/jobs.ts'
import { type Comparison, compareFrames, sideBySide } from '../review/compare.ts'
import { contactSheet, pngWriter, toPng } from '../review/review.ts'
import { insideFilm, open, parseRendering } from './args.ts'
import { clockWarning } from './clock.ts'
import { crop, objectRegion, parseRegion, type Region } from './crop.ts'
import { EXIT, found } from './findings.ts'

/**
 * The times to render: the times given, plus every `every` seconds from 0 when asked. Each must be
 * inside the film.
 */
export const stillTimes = (
  given: readonly number[],
  every: number | undefined,
  duration: number,
) => {
  const times = [...given]
  if (every !== undefined) {
    if (!(every > 0)) throw new Error('--every needs seconds above 0.')
    for (let t = 0; t < duration - 1e-9; t += every) times.push(Number(t.toFixed(6)))
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
 * writing a black frame. `--region` (frame pixels) or `--object` (an inspected object's `bbox`)
 * also writes that part of each still, enlarged `--scale` times by whole pixels: a close look.
 * `--compare <variant>` renders each t in that variant too and writes the pair side by side with
 * PSNR and mean ΔE between them: measured, never judged (decision 0011).
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v, times: given } = parseRendering(
    argv,
    {
      every: { type: 'string' },
      sheet: { type: 'boolean' },
      diff: { type: 'boolean' },
      out: { type: 'string' },
      region: { type: 'string' },
      object: { type: 'string' },
      scale: { type: 'string' },
      compare: { type: 'string' },
      json: { type: 'boolean' },
    },
    { command: 'still', times: true },
  )
  if (v.region && v.object) throw new Error('Give --region or --object, not both.')
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
    )
    const outDir = v.out ? resolve(v.out) : join(project.root, 'out', 'stills')
    mkdirSync(outDir, { recursive: true })
    const last = frameCount(fps, duration) - 1
    const name = safeName(variant)
    const pair = other ? `${name}-vs-${safeName(v.compare as string)}` : name
    const sheetWidth = other ? width * 2 : width
    const rendered: { t: number; label: string; pixels: Uint8Array }[] = []
    const stills: Still[] = []
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
          found({
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
      if (v.sheet) rendered.push({ t, label: pair, pixels: shown })
      stills.push(s)
      if (!v.json) console.log(lineOf(s))
    }
    let sheet: string | undefined
    if (v.sheet) {
      sheet = join(outDir, `${pair}-sheet.png`)
      await pngs.write(sheet, contactSheet(rendered, sheetWidth, height))
    }
    await pngs.done()
    if (sheet && !v.json) console.log(relative(process.cwd(), sheet))
    const warning = clockWarning(await child.clock())
    if (warning) {
      if (!v.json) console.log(`! ${warning}`)
      found({ code: 'clock', severity: 'warning', message: warning })
    }
    // PSNR of identical frames is Infinity, which JSON writes as null.
    if (v.json) console.log(JSON.stringify({ stills, ...(sheet ? { sheet } : {}) }, null, 2))
    else if (history > 0)
      console.log(
        `${history} frame(s) depend on history: export will refuse them (shaderera check).`,
      )
    return history > 0 ? EXIT.failed : EXIT.ok
  } finally {
    await Promise.all([child.close(), other?.child.close()])
  }
}
