// Makes the film the review-shots preview measures, and measures it with the plugin's own tool.
// The film is 6 s at 30 fps, made in code: five shots of 1.2 s over a field of points and rings,
// each in its own grade, with a known camera move: static, a push to 118%, a pan right at a quarter
// of the frame's width a second, a tilt down at 0.18, a pull from 118%. Writes
// audio/review-shots.mp4, then runs tools/review-shots.py on it into audio/review-shots/
// (shots.json, sheet-1.jpg). Needs ffmpeg and a Python with scenedetect (PYTHON names it). Run
// after scripts/assemble.ts.
//   node packages/plugins/review-shots/preview/make.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'

const FPS = 30
const W = 480
const H = 270
/** Each shot's grade (the ground, the points) and its move: scale from and to, and the camera's
 * pan in frame widths a second, x right and y down. */
const SHOTS = [
  { ground: '#101418', ink: '#9fb4c8', from: 1, to: 1, pan: [0, 0] },
  { ground: '#3a3026', ink: '#ffe6c4', from: 1, to: 1.18, pan: [0, 0] },
  { ground: '#18241c', ink: '#b8e0b0', from: 1, to: 1, pan: [0.25, 0] },
  { ground: '#262a3c', ink: '#8c96c8', from: 1, to: 1, pan: [0, 0.18] },
  { ground: '#000000', ink: '#ffffff', from: 1.18, to: 1, pan: [0, 0] },
] as const
const EACH = 36

const root = join(import.meta.dirname, '..', '..', 'previews')
mkdirSync(join(root, 'audio'), { recursive: true })

let seed = 0x5eed
const rand = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
  return seed / 4294967296
}

const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
const raw = Buffer.alloc(SHOTS.length * EACH * W * H * 4)
SHOTS.forEach((shot, k) => {
  // The world, twice the frame each way: points and rings to track, a new scatter every shot.
  const world = createCanvas(W * 2, H * 2)
  const g = world.getContext('2d')
  g.fillStyle = shot.ground
  g.fillRect(0, 0, W * 2, H * 2)
  for (let i = 0; i < 1400; i++) {
    const x = rand() * W * 2
    const y = rand() * H * 2
    const r = 1 + rand() ** 3 * 9
    g.globalAlpha = 0.3 + 0.7 * rand()
    g.fillStyle = shot.ink
    g.strokeStyle = shot.ink
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    if (i % 5) g.fill()
    else g.stroke()
  }
  g.globalAlpha = 1
  for (let f = 0; f < EACH; f++) {
    const s = shot.from * (shot.to / shot.from) ** (f / (EACH - 1))
    const cx = W + (shot.pan[0] * W * f) / FPS
    const cy = H + (shot.pan[1] * W * f) / FPS
    ctx.setTransform(s, 0, 0, s, W / 2 - s * cx, H / 2 - s * cy)
    ctx.drawImage(world, 0, 0)
    raw.set(ctx.getImageData(0, 0, W, H).data, (k * EACH + f) * W * H * 4)
  }
})
execFileSync(
  'ffmpeg',
  [
    ...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`],
    ...['-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16'],
    join(root, 'audio', 'review-shots.mp4'),
  ],
  { input: raw, maxBuffer: 2 ** 30 },
)

// The measurement, as a person would run it from the project root.
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
execFileSync(
  python,
  ['tools/review-shots.py', 'audio/review-shots.mp4', '--out', 'audio/review-shots'],
  { cwd: root, stdio: 'inherit' },
)
