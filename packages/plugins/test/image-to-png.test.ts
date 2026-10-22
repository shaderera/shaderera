// image-to-png, headless: its tool copied into a project the way `add` lays it out, a lossless
// WebP and a short GIF made here, converted to PNG beside them, and the PNGs read back.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { decode, encode } from 'fast-png'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'image-to-png')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'image-to-png', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'image-to-png', f), join(project, f))
}
mkdirSync(join(project, 'assets'), { recursive: true })
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: project })

const W = 24
const H = 16
/** ffmpeg reading raw RGB frames of W×H from stdin. */
const RAW = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`]
/** Straight RGBA with a ramp in every channel; alpha never 0, so a lossless WebP keeps every byte. */
const pixels = Uint8Array.from({ length: W * H * 4 }, (_, i) =>
  i % 4 === 3 ? 40 + (i % 200) : (i * 37) % 256,
)

test('image-to-png: a WebP becomes a PNG beside it, every pixel kept', { skip: !ffmpeg }, () => {
  writeFileSync(join(project, 'assets', 'art.png'), encode({ width: W, height: H, data: pixels }))
  const webp = ['-c:v', 'libwebp', '-lossless', '1', 'assets/art.webp']
  run('ffmpeg', ['-v', 'error', '-y', '-i', 'assets/art.png', ...webp])
  rmSync(join(project, 'assets', 'art.png'))
  run(process.execPath, ['tools/to-png.ts', 'assets/art.webp'])
  const png = decode(readFileSync(join(project, 'assets', 'art.png')))
  assert.deepEqual([png.width, png.height, png.channels, png.depth], [W, H, 4, 8])
  assert.deepEqual(png.data, pixels)
})

test('image-to-png: a clip becomes one PNG per frame at the rate asked', { skip: !ffmpeg }, () => {
  const frames = Buffer.concat(
    [0, 1, 2].map((k) => Buffer.from(Uint8Array.from({ length: W * H * 3 }, () => k * 100))),
  )
  execFileSync('ffmpeg', [...RAW, '-r', '3', '-i', '-', 'assets/clip.gif'], {
    cwd: project,
    input: frames,
  })
  run(process.execPath, ['tools/to-png.ts', '--frames', '3', 'assets/clip.gif'])
  const pngs = [1, 2, 3].map((n) =>
    decode(readFileSync(join(project, 'assets', `clip-00${n}.png`))),
  )
  assert.deepEqual(
    pngs.map((p) => [p.width, p.height]),
    [
      [W, H],
      [W, H],
      [W, H],
    ],
  )
  // In order: the GIF's palette moves the greys a little, never their order.
  const greys = pngs.map((p) => p.data[0] as number)
  assert.ok(
    greys[0] === 0 && (greys[1] as number) > 0 && (greys[2] as number) > (greys[1] as number),
  )
  assert.equal(existsSync(join(project, 'assets', 'clip-004.png')), false)
})
