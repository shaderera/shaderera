// Makes the film the review-av-timeline preview reviews, and reviews it with the item's own tool.
// The film is 6 s, made in code: a track at 120 BPM (a kick on every beat and a stab on five hits)
// and a picture of drifting lines of points that cuts to a flash on each hit, except the third,
// which lands 4 frames late on purpose. Writes audio/review-film.wav and audio/review-film.mp4,
// runs tools/av-review.ts on the mp4 at the five hits (audio/review-av/timeline.png, at-*.png) and
// keeps what it printed in audio/review-av/report.txt. Run after scripts/assemble.ts.
//   node packages/plugins/review-av-timeline/preview/make.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'

const RATE = 48000
const FPS = 30
const LENGTH = 6
const W = 480
const H = 270
/** The hits, on frame boundaries; the picture is late on the third. */
const HITS = [0.5, 1.7, 3.0, 4.2, 5.3]
const LATE = { hit: 3.0, frames: 4 }

// The previews project, where the composition reads its audio/.
const root = join(import.meta.dirname, '..', '..', 'previews')
const dir = join(root, 'audio')
mkdirSync(join(dir, 'review-av'), { recursive: true })

// The track.
const N = LENGTH * RATE
const mix = new Float64Array(N)
let seed = 0x1234567
const noise = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
  return (seed / 4294967296) * 2 - 1
}
const add = (at: number, len: number, f: (t: number) => number) => {
  const s = Math.round(at * RATE)
  for (let i = 0; i < len * RATE && s + i < N; i++) mix[s + i] = (mix[s + i] ?? 0) + f(i / RATE)
}
// A quiet bed under everything, so no hit starts out of digital silence: av-review drops an onset
// whose first 1/240 s is under -45 dB after silence.
{
  let a = 0
  add(0, LENGTH, (t) => {
    const n = noise()
    a += 0.08 * (n - a)
    return 0.05 * a * (0.8 + 0.2 * Math.sin(t * Math.PI * 4))
  })
}
for (let b = 0; b < 12; b++) {
  let phase = 0
  add(b * 0.5, 0.5, (t) => {
    phase += (2 * Math.PI * (48 + 110 * Math.exp(-t / 0.03))) / RATE
    return 0.3 * Math.sin(phase) * Math.exp(-t / 0.12)
  })
}
const NOTES = [57, 60, 64, 67, 72]
for (const [i, at] of HITS.entries()) {
  // A stab: detuned saws and a noise burst, sharp at the front.
  const f0 = 440 * 2 ** (((NOTES[i] ?? 60) - 69) / 12)
  let lp = 0
  add(at, 0.6, (t) => {
    let saw = 0
    for (const d of [0.995, 1, 1.006, 2]) saw += 2 * ((f0 * d * t) % 1) - 1
    lp += (0.04 + 0.5 * Math.exp(-t / 0.05)) * (saw - lp)
    return 0.4 * lp * Math.exp(-t / 0.2) + 0.6 * noise() * Math.exp(-t / 0.025)
  })
}
const peak = mix.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const wav = new DataView(new ArrayBuffer(44 + N * 4))
const text = (o: number, s: string) => {
  for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i))
}
text(0, 'RIFF')
wav.setUint32(4, 36 + N * 4, true)
text(8, 'WAVEfmt ')
wav.setUint32(16, 16, true)
wav.setUint16(20, 1, true)
wav.setUint16(22, 2, true)
wav.setUint32(24, RATE, true)
wav.setUint32(28, RATE * 4, true)
wav.setUint16(32, 4, true)
wav.setUint16(34, 16, true)
text(36, 'data')
wav.setUint32(40, N * 4, true)
for (let i = 0; i < N; i++) {
  const v = Math.round((((mix[i] ?? 0) * 10 ** (-5 / 20)) / peak) * 32767)
  wav.setInt16(44 + i * 4, v, true)
  wav.setInt16(46 + i * 4, v, true)
}
writeFileSync(join(dir, 'review-film.wav'), new Uint8Array(wav.buffer))

// The picture: lines of points drifting, and a flash with a block of light on each hit.
const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
const frames = LENGTH * FPS
const raw = Buffer.alloc(frames * W * H * 4)
const cuts = HITS.map((h) => Math.round(h * FPS) + (h === LATE.hit ? LATE.frames : 0))
for (let f = 0; f < frames; f++) {
  const t = f / FPS
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  for (let row = 0; row < 18; row++)
    for (let x = 0; x < W; x += 6) {
      const y = 20 + row * 13 + 6 * Math.sin(x * 0.03 + t * 2 + row)
      const a = 0.25 + 0.25 * Math.sin(x * 0.05 - t * 3 + row * 2)
      ctx.fillStyle = `rgba(255,255,255,${a})`
      ctx.fillRect((x + t * 20 * (row % 2 ? 1 : -1) + W) % W, y, 2, 2)
    }
  const since = Math.min(...cuts.map((c) => (f >= c ? f - c : 99)))
  const which = cuts.findLastIndex((c) => f >= c)
  if (since < 10 && which >= 0) {
    const k = Math.exp(-since / 2.5)
    ctx.fillStyle = `rgba(255,255,255,${k})`
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = `rgba(255,255,255,${0.4 + 0.6 * k})`
    const bw = W * (0.2 + 0.12 * which)
    ctx.fillRect(((which * 97) % (W - bw)) + 0, H * 0.25, bw, H * 0.5)
  }
  raw.set(ctx.getImageData(0, 0, W, H).data, f * W * H * 4)
}
const film = join(dir, 'review-film.mp4')
execFileSync(
  'ffmpeg',
  [
    ...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`],
    ...['-r', String(FPS), '-i', '-', '-i', join(dir, 'review-film.wav')],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-c:a', 'aac', '-b:a', '192k'],
    ...['-shortest', film],
  ],
  { input: raw, maxBuffer: 2 ** 30 },
)

// The review, as a film would run it.
const report = execFileSync(
  process.execPath,
  [
    join(root, 'tools', 'av-review.ts'),
    'audio/review-film.mp4',
    '--at',
    HITS.join(','),
    '--out',
    'audio/review-av',
  ],
  { cwd: root },
).toString()
writeFileSync(join(dir, 'review-av', 'report.txt'), report)
process.stdout.write(report)
