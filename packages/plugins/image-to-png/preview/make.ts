// Makes the image-to-png preview's inputs in code, then converts them with the plugin's own tool:
// a grey still with a light square, written as a lossless WebP (assets/to-png/still.webp), and a
// 12-frame GIF of a light disc crossing a grey ground (assets/to-png/clip.gif). The plugin's
// tools/to-png.ts turns them into still.png and clip-001.png … clip-012.png, which the picture
// reads. Run after scripts/assemble.ts (scripts/render.ts does both). Needs ffmpeg with libwebp.
//   node packages/plugins/image-to-png/preview/make.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const W = 320
const H = 240
const FRAMES = 12
/** ffmpeg reading raw RGB frames of W×H from stdin. */
const RAW = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`]

/** RGB bytes of a W×H picture, each pixel a grey level from `grey(x, y)`. */
const picture = (grey: (x: number, y: number) => number) => {
  const out = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      out.fill(Math.round(grey(x, y)), (y * W + x) * 3, (y * W + x + 1) * 3)
  return out
}
const still = picture((x, y) =>
  x > 110 && x < 210 && y > 70 && y < 170 ? 200 : 50 + (60 * (x + y)) / (W + H),
)
const frames = Array.from({ length: FRAMES }, (_, i) => {
  const cx = 40 + ((W - 80) * i) / (FRAMES - 1)
  return picture((x, y) => (Math.hypot(x - cx, y - H / 2) < 34 ? 210 : y % 40 < 2 ? 90 : 64))
})

// The previews project, where assets/ is gitignored and the composition reads it.
const root = join(import.meta.dirname, '..', '..', 'previews')
mkdirSync(join(root, 'assets', 'to-png'), { recursive: true })
const ffmpeg = (input: Uint8Array, out: string, fps: number, codec: string[]) =>
  execFileSync('ffmpeg', [...RAW, '-r', String(fps), '-i', '-', ...codec, out], {
    cwd: root,
    input,
  })
ffmpeg(still, 'assets/to-png/still.webp', 1, [
  '-frames:v',
  '1',
  '-c:v',
  'libwebp',
  '-lossless',
  '1',
])
// A palette made from the frames, so the greys stay grey.
const palette = 'split[a][b];[a]palettegen[p];[b][p]paletteuse'
ffmpeg(Buffer.concat(frames), 'assets/to-png/clip.gif', FRAMES, ['-vf', palette])
// The plugin, as a film would run it.
const tool = join(root, 'tools', 'to-png.ts')
const run = (args: string[]) =>
  execFileSync(process.execPath, [tool, ...args], { cwd: root, stdio: 'inherit' })
run(['assets/to-png/still.webp'])
run(['--frames', String(FRAMES), 'assets/to-png/clip.gif'])
