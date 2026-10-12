/**
 * Final frames of a project at sampled times, rendered in the Node host: their SHA-256 and,
 * optionally, PNGs. Compare two runs to see exactly which frames an edit changed.
 *
 *   node apps/cli/scripts/frames.ts <project dir> <out.json> [--step 0.5] [--variant name] [--png <dir> --at <t,t,…>]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { open } from '../src/cli/args.ts'

// Packages the CLI installs, resolved from it (this script lives outside any package).
const cli = createRequire(join(import.meta.dirname, '../package.json'))
const load = (name: string) => import(pathToFileURL(cli.resolve(name)).href)
const { createCanvas } = await load('@napi-rs/canvas')
const { frameTimes } = await load('@shaderera/core')
const { sha256 } = await load('@shaderera/core/host')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    step: { type: 'string' },
    png: { type: 'string' },
    at: { type: 'string' },
    variant: { type: 'string' },
    trusted: { type: 'boolean' },
    browser: { type: 'boolean' },
  },
})
const [root = '.', out = 'frames.json'] = positionals
const { project, child } = await open({
  root,
  variant: values.variant,
  trusted: values.trusted,
  browser: values.browser,
})
const { fps, duration, width, height } = project.manifest
const step = Number(values.step ?? 0.5)
const times = (frameTimes(fps, 0, duration) as number[]).filter(
  (t) => Math.abs(t / step - Math.round(t / step)) < 1e-6,
)
const stills = new Set((values.at ?? '').split(',').filter(Boolean).map(Number))
const hashes: Record<string, string> = {}
try {
  for (const t of times) {
    const { pixels } = await child.render(t, 'final')
    hashes[t.toFixed(3)] = await sha256(pixels)
  }
  if (values.png) {
    mkdirSync(values.png, { recursive: true })
    for (const t of stills) {
      const { pixels } = await child.render(t, 'final')
      const ctx = createCanvas(width, height).getContext('2d')
      const image = ctx.createImageData(width, height)
      image.data.set(pixels)
      ctx.putImageData(image, 0, 0)
      writeFileSync(join(values.png, `t${t.toFixed(2)}.png`), ctx.canvas.toBuffer('image/png'))
    }
  }
} finally {
  await child.close()
}
writeFileSync(out, `${JSON.stringify(hashes, null, 1)}\n`)
console.log(`${Object.keys(hashes).length} frames → ${out}`)
