// Renders the previews for the website. It finds every plugin with a preview
// (packages/plugins/<plugin>/preview/preview.json), writes their variants into shaderera.json, and
// renders every state of every plugin (or of the plugins named) into its own preview/out/
// (gitignored: the renders are made from the code, so the code is what is kept):
//   <plugin>.mp4          the default state, 1080, with sound for an audio plugin
//   <state>.mp4           each state, 1080
//   loop.webp             the default state for the grid: 480, 15 fps, loops forever
//   loop-<state>.webp     each state, the same
//   frames/0000.webp ...  30 frames evenly over the loop, 1080, for scrubbing
//   poster.webp, .png     a strong frame of the default state
//   preview.json          the caption and states, for the page to build the interaction from
// It copies the plugins in first (scripts/assemble.ts) and runs a plugin's preview/make.ts, when
// it has one, before rendering it (its sound, a film to review). Needs ffmpeg with libwebp.
//   node scripts/render.ts [plugin...]
//   node scripts/render.ts --variants    only write the variants, to look with `shaderera still`

import { execFile, execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PreviewConfig } from '../src/preview.ts'

const root = join(import.meta.dirname, '..')
const plugins = join(root, '..')
const cli = join(root, '..', '..', '..', 'apps', 'cli', 'bin', 'shaderera.js')
const FRAMES = 30
/** The mp4s' x264 crf, unless a plugin's preview.json sets its own. */
const CRF = 20
/** The grid's loop must stay under this; fine patterns (halftone, particles) step down to it. */
const LOOP_BYTES = 1.5e6
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
const shaderera = (args: string[]) => run(process.execPath, [cli, ...args, '--root', root])
const ffmpeg = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args])
const ffmpegAsync = (args: string[]) =>
  promisify(execFile)('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: root })
/** Runs `jobs` a few at a time: the WebP encoder is single-threaded, so encodes go side by side. */
const pool = async (
  jobs: (() => Promise<unknown>)[],
  n = Math.max(2, availableParallelism() - 2),
) => {
  const queue = [...jobs]
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await job()
    }),
  )
}

// Every plugin with a preview, in alphabetical order (the order house.ts numbers them in).
const previews = new Map<string, PreviewConfig>()
for (const name of readdirSync(plugins).sort()) {
  const file = join(plugins, name, 'preview', 'preview.json')
  if (!existsSync(file)) continue
  const config = JSON.parse(readFileSync(file, 'utf8')) as PreviewConfig
  if (!config.states.some((s) => s.id === config.default))
    throw new Error(`${file}: the default "${config.default}" is not one of its states`)
  if (!existsSync(join(plugins, name, 'preview', 'index.ts')))
    throw new Error(`${name} has preview/preview.json but no preview/index.ts`)
  previews.set(name, config)
}
const variantOf = (name: string, state: string) =>
  state === previews.get(name)?.default ? name : `${name}.${state}`

// The variants, from the preview.json files: `<plugin>` is the default state, `<plugin>.<state>`
// the others. Written only when they change.
const manifestFile = join(root, 'shaderera.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
  fps: number
  duration: number
  params: { properties: { item: { enum?: string[]; default?: string } } }
  variants: Record<string, unknown>
}
const names = [...previews.keys()]
const item = manifest.params.properties.item
item.enum = names
if (!item.default || !names.includes(item.default)) item.default = names[0]
manifest.variants = Object.fromEntries(
  [...previews].flatMap(([name, config]) =>
    config.states.map((s) => [
      variantOf(name, s.id),
      {
        label: config.states.length > 1 ? `${name} · ${s.id}` : name,
        params: { item: name, state: s.id },
      },
    ]),
  ),
)
const written = `${JSON.stringify(manifest, null, 2)}\n`
if (readFileSync(manifestFile, 'utf8') !== written) writeFileSync(manifestFile, written)

const args = process.argv.slice(2)
if (args.includes('--variants')) process.exit(0)

run(process.execPath, [join(root, 'scripts', 'assemble.ts')])

for (const name of args.length > 0 ? args : names) {
  const config = previews.get(name)
  if (!config)
    throw new Error(`No preview for ${name}; the plugins with one are ${names.join(', ')}`)
  const make = join(plugins, name, 'preview', 'make.ts')
  if (existsSync(make)) run(process.execPath, [make])
  const out = join(plugins, name, 'preview', 'out')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'frames'), { recursive: true })

  // The mp4s one after another (the GPU), then every state's loop at once (the CPU).
  for (const s of config.states) {
    const mp4 = join(out, `${s.id}.mp4`)
    shaderera([
      'render',
      '--variant',
      variantOf(name, s.id),
      '--out',
      mp4,
      '--encoder',
      'x264',
      '--crf',
      String(config.crf ?? CRF),
      ...(config.audio ? [] : ['--no-audio']),
    ])
  }
  // The grid's loop: quality 70 at 15 fps, lower while it is over 1.5 MB, then fewer frames.
  // compression_level 4 is about twice as fast as 6 for a few percent more bytes.
  await pool(
    config.states.map((s) => async () => {
      const mp4 = join(out, `${s.id}.mp4`)
      const loop = join(out, `loop-${s.id}.webp`)
      for (const fps of [15, 12, 10])
        for (const q of [70, 60, 50, 40, 30]) {
          await ffmpegAsync([
            ...['-i', mp4, '-vf', `fps=${fps},scale=480:480:flags=lanczos`, '-an'],
            ...['-c:v', 'libwebp_anim', '-loop', '0', '-q:v', String(q), '-compression_level', '4'],
            loop,
          ])
          if (statSync(loop).size <= LOOP_BYTES) return
        }
    }),
  )
  copyFileSync(join(out, `${config.default}.mp4`), join(out, `${name}.mp4`))
  copyFileSync(join(out, `loop-${config.default}.webp`), join(out, 'loop.webp'))

  // The scrub strip and the poster, from lossless stills of the default state.
  const stills = join(out, '.stills')
  const variant = variantOf(name, config.default)
  const times = Array.from({ length: FRAMES }, (_, i) => (i * manifest.duration) / FRAMES)
  shaderera([
    'still',
    ...times.map(String),
    String(config.poster),
    '--variant',
    variant,
    '--out',
    stills,
  ])
  const png = (t: number) => join(stills, `${variant}-${t.toFixed(3)}.png`)
  await pool(
    times.map(
      (t, i) => () =>
        ffmpegAsync([
          ...['-i', png(t), '-c:v', 'libwebp', '-q:v', '85'],
          join(out, 'frames', `${String(i).padStart(4, '0')}.webp`),
        ]),
    ),
  )
  copyFileSync(png(config.poster), join(out, 'poster.png'))
  ffmpeg(['-i', png(config.poster), '-c:v', 'libwebp', '-q:v', '90', join(out, 'poster.webp')])
  rmSync(stills, { recursive: true, force: true })

  writeFileSync(
    join(out, 'preview.json'),
    `${JSON.stringify(
      {
        item: name,
        caption: config.caption,
        states: config.states,
        default: config.default,
        frames: FRAMES,
        fps: manifest.fps,
        duration: manifest.duration,
        audio: config.audio,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`packages/plugins/${name}/preview/out/`)
}
