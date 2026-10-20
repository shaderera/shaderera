// Sound and motion for a reviewer who cannot hear or watch: the rendered film's sound as pictures,
// how much the picture changes frame by frame on the same time axis, frame strips around chosen
// moments, and the measured offset between each moment's picture and its sound.
//
//   node tools/av-review.ts out/film.mp4 [--at 3.29,8.1,…] [--out out/av]
//
// Writes:
//   timeline.png   spectrogram, waveform, sound onsets (ticks) and picture change (the lower curve)
//                  over the whole film, with the --at moments marked; dense spikes in the lower
//                  curve are fast motion or cuts, flat stretches are holds
//   at-<t>.png     every frame from 0.15 s before to 0.3 s after t, with the waveform under it:
//                  look for the frame where the picture hits against where the sound hits
// and prints, for each --at moment, the nearest sound onset and the nearest picture-change peak and
// how far apart they are. Picture up to ~45 ms after the sound reads as in sync; picture before
// the sound is noticed sooner (~20 ms). Needs ffmpeg and ffprobe on PATH.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Canvas, ImageData, loadImage } from '@napi-rs/canvas'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { at: { type: 'string', default: '' }, out: { type: 'string', default: 'out/av' } },
})
const film = positionals[0]
if (!film) throw new Error('Usage: node tools/av-review.ts <film.mp4> [--at t1,t2] [--out dir]')
const out = values.out as string
mkdirSync(out, { recursive: true })
const moments = (values.at as string)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)

const probe = JSON.parse(
  execFileSync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    film,
  ]).toString(),
)
const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
const hasAudio = probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio')
const [num, den] = String(video.r_frame_rate).split('/').map(Number)
const fps = (num as number) / (den || 1)
const duration = Number(probe.format.duration)

// The picture: every frame small and grey, and how much each differs from the one before.
const SW = 96
const SH = Math.max(2, Math.round((SW * video.height) / video.width / 2) * 2)
const grey = execFileSync(
  'ffmpeg',
  ['-v', 'error', '-i', film, '-vf', `scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-'],
  {
    maxBuffer: 2 ** 30,
  },
)
const frames = Math.floor(grey.length / (SW * SH))
const change = new Float64Array(frames)
for (let f = 1; f < frames; f++) {
  let s = 0
  for (let i = 0; i < SW * SH; i++)
    s += Math.abs((grey[f * SW * SH + i] as number) - (grey[(f - 1) * SW * SH + i] as number))
  change[f] = s / (SW * SH * 255)
}

// The sound: loudness per film frame, and onsets where it rises sharply.
const RATE = 24000
const pcm = hasAudio
  ? execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', film, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
      { maxBuffer: 2 ** 30 },
    )
  : Buffer.alloc(0)
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4))
const hop = RATE / 240 // onsets at 1/240 s
const steps = Math.floor(samples.length / hop)
const db = new Float64Array(steps)
for (let k = 0; k < steps; k++) {
  let s = 0
  for (let i = 0; i < hop; i++) s += (samples[k * hop + i] ?? 0) ** 2
  db[k] = 10 * Math.log10(s / hop + 1e-10)
}
const rise = Array.from(db, (v, k) =>
  Math.max(0, v - Math.max(...Array.from(db.subarray(Math.max(0, k - 12), k)), -100)),
)
const mean = rise.reduce((a, b) => a + b, 0) / Math.max(1, rise.length)
const sd = Math.sqrt(rise.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rise.length))
const onsets: number[] = []
for (let k = 1; k < steps - 1; k++)
  if (
    (rise[k] as number) > mean + 2.5 * sd &&
    (rise[k] as number) >= (rise[k - 1] as number) &&
    (rise[k] as number) > (rise[k + 1] as number) &&
    (db[k] as number) > -45
  ) {
    const t = k / 240
    if (!onsets.length || t - (onsets.at(-1) as number) > 0.06) onsets.push(t)
  }

// Picture-change peaks: frames that change much more than their neighbours.
const peaks: number[] = []
for (let f = 2; f < frames - 1; f++) {
  const local = Array.from(change.subarray(Math.max(1, f - 6), f + 7)).sort((a, b) => a - b)
  const median = local[Math.floor(local.length / 2)] as number
  if (
    (change[f] as number) > median * 2 + 0.01 &&
    (change[f] as number) >= (change[f - 1] as number) &&
    (change[f] as number) >= (change[f + 1] as number)
  )
    peaks.push(f / fps)
}

// timeline.png
const W = 1800
const specH = 220
const waveH = 90
const curveH = 120
const pad = 24
const H = pad + specH + waveH + curveH + pad * 2
const canvas = new Canvas(W, H)
const ctx = canvas.getContext('2d')
ctx.fillStyle = '#111'
ctx.fillRect(0, 0, W, H)
const x = (t: number) => (t / duration) * W
if (hasAudio) {
  const spec = join(out, 'spectrum.png')
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    film,
    '-lavfi',
    `showspectrumpic=s=${W}x${specH}:legend=0:scale=log:fscale=log:start=20:stop=16000:color=intensity`,
    '-frames:v',
    '1',
    spec,
  ])
  ctx.drawImage(await loadImage(spec), 0, pad, W, specH)
  ctx.strokeStyle = '#7fb3ff'
  ctx.beginPath()
  const y0 = pad + specH + waveH / 2
  for (let px = 0; px < W; px++) {
    const a = Math.floor((px / W) * samples.length)
    const b = Math.floor(((px + 1) / W) * samples.length)
    let m = 0
    for (let i = a; i < b; i++) m = Math.max(m, Math.abs(samples[i] ?? 0))
    ctx.moveTo(px + 0.5, y0 - m * (waveH / 2))
    ctx.lineTo(px + 0.5, y0 + m * (waveH / 2))
  }
  ctx.stroke()
  ctx.fillStyle = '#ffd24a'
  for (const t of onsets) ctx.fillRect(x(t), pad + specH, 1, 10)
}
const cy = pad + specH + waveH + pad
const top = Math.max(...change, 1e-6)
ctx.strokeStyle = '#9be59b'
ctx.beginPath()
for (let f = 1; f < frames; f++) {
  const px = x(f / fps)
  const py = cy + curveH - ((change[f] as number) / top) * curveH
  if (f === 1) ctx.moveTo(px, py)
  else ctx.lineTo(px, py)
}
ctx.stroke()
ctx.font = '12px sans-serif'
ctx.fillStyle = '#ccc'
for (let s = 0; s <= duration; s += 1) {
  ctx.fillRect(x(s), H - pad, 1, s % 5 === 0 ? 8 : 4)
  if (s % 5 === 0) ctx.fillText(`${s}s`, x(s) + 2, H - 4)
}
ctx.fillText('spectrum', 6, pad - 6)
ctx.fillText('waveform · onsets', 6, pad + specH + 12)
ctx.fillText('picture change', 6, cy - 4)
ctx.fillStyle = 'rgba(255,70,70,0.9)'
for (const t of moments) ctx.fillRect(x(t), pad, 2, H - 2 * pad)
writeFileSync(join(out, 'timeline.png'), await canvas.encode('png'))

// at-<t>.png: every frame around each moment, the waveform under them.
const nearest = (list: number[], t: number, within = 0.15) => {
  let best: number | null = null
  for (const v of list)
    if (Math.abs(v - t) <= within && (best === null || Math.abs(v - t) < Math.abs(best - t)))
      best = v
  return best
}
const ms = (s: number) => `${s >= 0 ? '+' : ''}${Math.round(s * 1000)} ms`
for (const t of moments) {
  // On the frame grid, and sought half a frame early: ffmpeg starts at the first frame at or after
  // -ss, and four decimals can round a frame's time past it.
  const from = Math.max(0, Math.ceil((t - 0.15) * fps - 1e-6) / fps)
  const to = Math.min(duration, t + 0.3)
  const tw = 200
  const th = Math.round((tw * video.height) / video.width / 2) * 2
  const raw = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      Math.max(0, from - 0.5 / fps).toFixed(4),
      '-i',
      film,
      '-t',
      (to - from).toFixed(4),
      '-vf',
      `scale=${tw}:${th},format=rgba`,
      '-f',
      'rawvideo',
      '-',
    ],
    {
      maxBuffer: 1 << 30,
    },
  )
  const n = Math.floor(raw.length / (tw * th * 4))
  const cols = Math.min(n, 9)
  const rows = Math.ceil(n / cols)
  const sheet = new Canvas(cols * (tw + 4), rows * (th + 22) + 80)
  const sc = sheet.getContext('2d')
  sc.fillStyle = '#111'
  sc.fillRect(0, 0, sheet.width, sheet.height)
  sc.font = '12px sans-serif'
  for (let i = 0; i < n; i++) {
    const ft = from + i / fps
    const px = (i % cols) * (tw + 4)
    const py = Math.floor(i / cols) * (th + 22)
    sc.putImageData(
      new ImageData(
        new Uint8ClampedArray(raw.subarray(i * tw * th * 4, (i + 1) * tw * th * 4)),
        tw,
        th,
      ),
      px,
      py + 18,
    )
    sc.fillStyle = Math.abs(ft - t) < 0.5 / fps ? '#ff6b6b' : '#bbb'
    sc.fillText(`${ft.toFixed(3)}s (${ms(ft - t)})`, px + 4, py + 13)
  }
  // The waveform of the same span, with the moment and the sound's onsets.
  const wy = rows * (th + 22) + 10
  const ww = sheet.width
  sc.strokeStyle = '#7fb3ff'
  sc.beginPath()
  for (let px = 0; px < ww; px++) {
    const a = Math.floor((from + ((to - from) * px) / ww) * RATE)
    const b = Math.floor((from + ((to - from) * (px + 1)) / ww) * RATE)
    let m = 0
    for (let i = a; i < b; i++) m = Math.max(m, Math.abs(samples[i] ?? 0))
    sc.moveTo(px + 0.5, wy + 30 - m * 30)
    sc.lineTo(px + 0.5, wy + 30 + m * 30)
  }
  sc.stroke()
  const sx = (s: number) => ((s - from) / (to - from)) * ww
  sc.fillStyle = '#ffd24a'
  for (const o of onsets) if (o >= from && o <= to) sc.fillRect(sx(o), wy, 2, 60)
  sc.fillStyle = '#ff6b6b'
  sc.fillRect(sx(t), wy, 2, 60)
  writeFileSync(join(out, `at-${t.toFixed(3)}.png`), await sheet.encode('png'))
  const sound = nearest(onsets, t)
  const picture = nearest(peaks, t)
  const gap = sound !== null && picture !== null ? picture - sound : null
  console.log(
    `t ${t.toFixed(3)}: sound onset ${sound === null ? 'none within 150 ms' : `${sound.toFixed(3)} (${ms(sound - t)})`}, picture peak ${picture === null ? 'none within 150 ms' : `${picture.toFixed(3)} (${ms(picture - t)})`}${gap === null ? '' : `, picture − sound ${ms(gap)} (${(gap * fps).toFixed(1)} frames)${gap < -0.02 || gap > 0.045 ? '  ← out of sync' : ''}`}`,
  )
}
console.log(
  `${join(out, 'timeline.png')}: ${onsets.length} sound onsets, ${peaks.length} picture-change peaks over ${duration.toFixed(2)} s at ${fps} fps`,
)
