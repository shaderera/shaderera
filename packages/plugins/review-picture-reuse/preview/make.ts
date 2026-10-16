// Makes the film the review-picture-reuse preview measures, and measures it with review-shots and
// then the plugin's own tool. The film is 6 s at 30 fps, made in code: eight shots of four
// pictures (shapes on a ground, each in its own grade), each slowly pushing in. A comes back
// cropped twice, B once, C is cut into right after itself, D is shown once. Writes
// audio/review-picture-reuse.mp4, then runs tools/review-shots.py and
// tools/review-picture-reuse.py on it into audio/review-picture-reuse/ (shots.json, sheet-1.jpg,
// picture-reuse.json). Needs ffmpeg and a Python with scenedetect (PYTHON names it). Run after
// scripts/assemble.ts.
//   node packages/plugins/review-picture-reuse/preview/make.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'

const FPS = 30
const W = 480
const H = 270
/** Each picture's grade: the ground and the shapes. */
const PICTURES = {
  A: { ground: '#14181c', ink: '#cfd8e0' },
  B: { ground: '#3a2a1c', ink: '#ffcf96' },
  C: { ground: '#162a1e', ink: '#a8e6b4' },
  D: { ground: '#241c3a', ink: '#c4b4ff' },
} as const
/** Each shot: its picture, its length in frames, and its crop (the scale, and the centre in the
 * picture's own frame-sized units, 0.5 the middle). Lengths sum to 180. */
const SHOTS = [
  { picture: 'A', frames: 24, scale: 1, at: [0.5, 0.5] },
  { picture: 'B', frames: 24, scale: 1, at: [0.5, 0.5] },
  { picture: 'A', frames: 21, scale: 1.7, at: [0.35, 0.4] },
  { picture: 'C', frames: 24, scale: 1, at: [0.5, 0.5] },
  { picture: 'C', frames: 18, scale: 1.5, at: [0.62, 0.58] },
  { picture: 'D', frames: 24, scale: 1, at: [0.5, 0.5] },
  { picture: 'B', frames: 21, scale: 1.45, at: [0.6, 0.38] },
  { picture: 'A', frames: 24, scale: 1.3, at: [0.6, 0.6] },
] as const
/** How much each shot grows over its length: something moves on every frame. */
const PUSH = 1.04

const root = join(import.meta.dirname, '..', '..', 'previews')
mkdirSync(join(root, 'audio'), { recursive: true })

let seed = 0x5eed
const rand = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
  return seed / 4294967296
}

// Each picture once: rectangles, discs and rings to match, a new scatter every picture.
const pictures = Object.fromEntries(
  Object.entries(PICTURES).map(([name, grade]) => {
    const picture = createCanvas(W, H)
    const g = picture.getContext('2d')
    g.fillStyle = grade.ground
    g.fillRect(0, 0, W, H)
    g.fillStyle = grade.ink
    g.strokeStyle = grade.ink
    g.lineWidth = 2
    for (let i = 0; i < 120; i++) {
      const x = rand() * W
      const y = rand() * H
      const r = 3 + rand() ** 2 * 26
      g.globalAlpha = 0.25 + 0.75 * rand()
      if (i % 3 === 0) g.fillRect(x, y, r * 1.6, r)
      else {
        g.beginPath()
        g.arc(x, y, r, 0, Math.PI * 2)
        if (i % 3 === 1) g.fill()
        else g.stroke()
      }
    }
    return [name, picture]
  }),
)

const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
const raw = Buffer.alloc(180 * W * H * 4)
let n = 0
for (const shot of SHOTS)
  for (let f = 0; f < shot.frames; f++) {
    const s = shot.scale * PUSH ** (f / (shot.frames - 1))
    const [cx, cy] = [shot.at[0] * W, shot.at[1] * H]
    ctx.setTransform(s, 0, 0, s, W / 2 - s * cx, H / 2 - s * cy)
    ctx.drawImage(pictures[shot.picture] as (typeof pictures)[string], 0, 0)
    raw.set(ctx.getImageData(0, 0, W, H).data, n++ * W * H * 4)
  }
execFileSync(
  'ffmpeg',
  [
    ...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`],
    ...['-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16'],
    join(root, 'audio', 'review-picture-reuse.mp4'),
  ],
  { input: raw, maxBuffer: 2 ** 30 },
)

// The shots, then the repeats, as a person would run them from the project root.
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const run = (...args: string[]) => execFileSync(python, args, { cwd: root, stdio: 'inherit' })
run(
  'tools/review-shots.py',
  'audio/review-picture-reuse.mp4',
  '--out',
  'audio/review-picture-reuse',
)
run('tools/review-picture-reuse.py', 'audio/review-picture-reuse/shots.json')
