import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { frameCount } from '@shaderera/core/host'
import { encodePng } from '../deliver/png.ts'
import { contactSheet, toPng } from '../review/review.ts'
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

/**
 * `shaderera still <t>... [--time t]... [--every s] [--sheet] [--diff] [--param k=v]... [--out dir]
 * [--region x,y,w,h | --object id] [--scale n]`
 *
 * Stills of any moment straight from the source, rendered by the same host as `check` and
 * `render`, so a shader that does not compile or a WebGPU error fails the still instead of
 * writing a black frame. `--region` (frame pixels) or `--object` (an inspected object's `bbox`)
 * also writes that part of each still, enlarged `--scale` times by whole pixels: a close look.
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
    },
    { command: 'still', times: true },
  )
  if (v.region && v.object) throw new Error('Give --region or --object, not both.')
  const scale = v.scale === undefined ? 1 : Number(v.scale)
  const { project, child } = await open(v)
  try {
    const { width, height, duration, fps } = project.manifest
    const times = stillTimes(given, v.every === undefined ? undefined : Number(v.every), duration)
    const variant = typeof v.variant === 'string' ? v.variant : 'main'
    const outDir = v.out ? resolve(v.out) : join(project.root, 'out', 'stills')
    mkdirSync(outDir, { recursive: true })
    const last = frameCount(fps, duration) - 1
    const rendered: { t: number; label: string; pixels: Uint8Array }[] = []
    let history = 0
    for (const t of times) {
      const started = performance.now()
      const { pixels } = await child.render(t, 'final')
      const ms = performance.now() - started
      const file = join(outDir, `${variant}-${t.toFixed(3)}.png`)
      writeFileSync(file, toPng(pixels, width, height))
      // Kept only for the sheet: `--every` over a long film would hold every frame in memory.
      if (v.sheet) rendered.push({ t, label: variant, pixels })
      let line = `${relative(process.cwd(), file)}  ${ms.toFixed(0)} ms`
      const region: Region | undefined = v.region
        ? parseRegion(v.region)
        : v.object
          ? objectRegion(await child.inspect(t), v.object)
          : undefined
      if (region) {
        const c = crop(pixels, { width, height }, region, scale)
        const r = c.region
        const part = join(
          outDir,
          `${variant}-${t.toFixed(3)}-${r.x}_${r.y}_${r.width}x${r.height}@${scale}.png`,
        )
        writeFileSync(part, encodePng(c.pixels, c.width, c.height))
        line += `\n${relative(process.cwd(), part)}  ${r.width}×${r.height} at ${r.x},${r.y}, ×${scale}`
      }
      if (v.diff) {
        // A far-away frame first: a frame that depends on history comes back different.
        const away = Math.round(t * fps) > last / 2 ? 0 : last / fps
        await child.render(away, 'final')
        const again = (await child.render(t, 'final')).pixels
        let n = 0
        for (let i = 0; i < pixels.length; i++) if (pixels[i] !== again[i]) n++
        line += `  differing channels after a jump: ${n}`
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
      console.log(line)
    }
    if (v.sheet) {
      const file = join(outDir, `${variant}-sheet.png`)
      writeFileSync(file, contactSheet(rendered, width, height))
      console.log(relative(process.cwd(), file))
    }
    const warning = clockWarning(await child.clock())
    if (warning) {
      console.log(`! ${warning}`)
      found({ code: 'clock', severity: 'warning', message: warning })
    }
    if (history > 0)
      console.log(
        `${history} frame(s) depend on history: export will refuse them (shaderera check).`,
      )
    return history > 0 ? EXIT.failed : EXIT.ok
  } finally {
    await child.close()
  }
}
