// Renders the previews for the website, every state of every item (or the items named), into
// out/<item>/:
//   <item>.mp4            the default state, 1080, with sound for an audio item
//   <state>.mp4           each state, 1080
//   loop.webp             the default state for the grid: 480, 15 fps, loops forever
//   loop-<state>.webp     each state, the same
//   frames/0000.webp ...  30 frames evenly over the loop, 1080, for scrubbing
//   poster.webp, .png     a strong frame of the default state
//   preview.json          the caption and states, for the page to build the interaction from
// It copies the catalog items in first (scripts/assemble.ts) and makes the track and its analysis
// when they are missing. Needs ffmpeg with libwebp on the PATH.
//   node scripts/render.ts [item...]

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ITEMS, variantOf } from '../src/items.ts'

const root = join(import.meta.dirname, '..')
const cli = join(root, '..', '..', '..', 'apps', 'cli', 'bin', 'shaderera.js')
const FRAMES = 30
const LOOP_BYTES = 1.5e6
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
const shaderera = (args: string[]) => run(process.execPath, [cli, ...args, '--root', root])
const ffmpeg = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args])

run(process.execPath, [join(root, 'scripts', 'assemble.ts')])
const song = join(root, 'audio', 'beat.wav')
const analysis = join(root, 'audio', 'beat.analysis.json')
if (!existsSync(song)) run(process.execPath, [join(root, 'scripts', 'make-track.ts')])
if (!existsSync(analysis) || statSync(analysis).mtimeMs < statSync(song).mtimeMs)
  // The track is 160 BPM; the default 70–180 range would also take 80.
  run(process.execPath, [
    join(root, 'tools', 'analyze-music.ts'),
    'audio/beat.wav',
    '--min-bpm',
    '120',
    '--max-bpm',
    '180',
  ])

const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8')) as {
  fps: number
  duration: number
  variants: Record<string, unknown>
}
const names = process.argv.slice(2)
for (const name of names.length > 0 ? names : Object.keys(ITEMS)) {
  const item = ITEMS[name]
  if (!item)
    throw new Error(`No preview for ${name}; the items are ${Object.keys(ITEMS).join(', ')}`)
  for (const s of item.states)
    if (!manifest.variants[variantOf(name, s.id)])
      throw new Error(
        `shaderera.json has no variant ${variantOf(name, s.id)} for ${name}'s state ${s.id}`,
      )
  const out = join(root, 'out', name)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'frames'), { recursive: true })

  for (const s of item.states) {
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
      '20',
      ...(item.audio ? [] : ['--no-audio']),
    ])
    // The grid's loop: quality 70, lower while it is over 1.5 MB (fine patterns like halftone).
    const loop = join(out, `loop-${s.id}.webp`)
    for (const q of [70, 60, 50, 40, 30]) {
      ffmpeg([
        ...['-i', mp4, '-vf', 'fps=15,scale=480:480:flags=lanczos', '-an'],
        ...['-c:v', 'libwebp_anim', '-loop', '0', '-q:v', String(q), '-compression_level', '6'],
        loop,
      ])
      if (statSync(loop).size <= LOOP_BYTES) break
    }
  }
  copyFileSync(join(out, `${item.default}.mp4`), join(out, `${name}.mp4`))
  copyFileSync(join(out, `loop-${item.default}.webp`), join(out, 'loop.webp'))

  // The scrub strip and the poster, from lossless stills of the default state.
  const stills = join(out, '.stills')
  const variant = variantOf(name, item.default)
  const times = Array.from({ length: FRAMES }, (_, i) => (i * manifest.duration) / FRAMES)
  shaderera([
    'still',
    ...times.map(String),
    String(item.poster),
    '--variant',
    variant,
    '--out',
    stills,
  ])
  const png = (t: number) => join(stills, `${variant}-${t.toFixed(3)}.png`)
  times.forEach((t, i) => {
    ffmpeg([
      '-i',
      png(t),
      '-c:v',
      'libwebp',
      '-q:v',
      '85',
      join(out, 'frames', `${String(i).padStart(4, '0')}.webp`),
    ])
  })
  copyFileSync(png(item.poster), join(out, 'poster.png'))
  ffmpeg(['-i', png(item.poster), '-c:v', 'libwebp', '-q:v', '90', join(out, 'poster.webp')])
  rmSync(stills, { recursive: true, force: true })

  writeFileSync(
    join(out, 'preview.json'),
    `${JSON.stringify(
      {
        item: name,
        caption: item.caption,
        states: item.states,
        default: item.default,
        frames: FRAMES,
        fps: manifest.fps,
        duration: manifest.duration,
        audio: item.audio,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`out/${name}/`)
}
