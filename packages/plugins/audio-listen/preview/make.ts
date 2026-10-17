// Makes the audio-listen preview's recording in code: a 6 s sheet of seven takes, three of them
// whooshes (noise through a band-pass that sweeps up and falls back, loudest a few hundred ms in),
// and between them a click, a beep, a knock and a pop. Writes audio/listen.wav, then copies the
// trims CLAP heard in it (preview/listen.trims.json) to audio/listen.trims.json. Run after
// scripts/assemble.ts (scripts/render.ts does both).
//   node packages/plugins/audio-listen/preview/make.ts
//
// The trims are kept, not heard here: hearing needs @huggingface/transformers and a 780 MB model,
// which this harness does not install. After changing the recording, hear it again in a project
// that has them, and copy the trims file over preview/listen.trims.json:
//   node tools/listen.ts audio/listen.wav "a whoosh" --top 7
// This script refuses kept trims of another recording, so a changed sound never ships with old ones.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RATE = 48000
const LENGTH = 6
const N = LENGTH * RATE
const out = new Float64Array(N)
let seed = 11
const noise = () => {
  seed = (seed * 16807) % 2147483647
  return (seed / 2147483647) * 2 - 1
}
const put = (at: number, length: number, f: (t: number) => number) => {
  const from = Math.round(at * RATE)
  for (let i = 0; i < length * RATE && from + i < N; i++)
    out[from + i] = (out[from + i] ?? 0) + f(i / RATE)
}
/** Noise through a band-pass whose centre rises from f0 to f1 and falls back, swelling to `rise`. */
const whoosh = (at: number, length: number, rise: number, f0: number, f1: number) => {
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  put(at, length, (t) => {
    const f = f0 * (f1 / f0) ** Math.sin((Math.PI * t) / length)
    const w = (2 * Math.PI * f) / RATE
    const alpha = Math.sin(w) / (2 * 1.8)
    const x = noise()
    const y = (alpha * x - alpha * x2 + 2 * Math.cos(w) * y1 - (1 - alpha) * y2) / (1 + alpha)
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    const env = t < rise ? (t / rise) ** 2 : Math.exp(-(t - rise) / ((length - rise) / 4))
    return 2.2 * env * y
  })
}
whoosh(0.25, 0.75, 0.32, 350, 2400)
put(1.3, 0.12, (t) => Math.exp(-t / 0.0025) * noise())
whoosh(1.75, 0.55, 0.2, 600, 3200)
put(
  2.8,
  0.25,
  (t) => 0.35 * Math.min(1, t / 0.005, (0.25 - t) / 0.01) * Math.sin(2 * Math.PI * 1200 * t),
)
put(
  3.4,
  0.3,
  (t) =>
    Math.exp(-t / 0.06) * Math.sin(2 * Math.PI * 160 * t) + 0.4 * Math.exp(-t / 0.008) * noise(),
)
whoosh(3.95, 1.0, 0.45, 250, 1800)
put(
  5.3,
  0.12,
  (t) => Math.exp(-t / 0.03) * Math.sin(2 * Math.PI * (200 + 400 * Math.exp(-t / 0.01)) * t),
)

const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const gain = 10 ** (-3 / 20) / peak
const wav = new DataView(new ArrayBuffer(44 + N * 2))
const text = (o: number, s: string) => {
  for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i))
}
text(0, 'RIFF')
wav.setUint32(4, 36 + N * 2, true)
text(8, 'WAVEfmt ')
wav.setUint32(16, 16, true)
wav.setUint16(20, 1, true)
wav.setUint16(22, 1, true)
wav.setUint32(24, RATE, true)
wav.setUint32(28, RATE * 2, true)
wav.setUint16(32, 2, true)
wav.setUint16(34, 16, true)
text(36, 'data')
wav.setUint32(40, N * 2, true)
for (let i = 0; i < N; i++) wav.setInt16(44 + i * 2, Math.round((out[i] ?? 0) * gain * 32767), true)

// The previews project, where the composition reads its audio/.
const root = join(import.meta.dirname, '..', '..', 'previews')
const bytes = new Uint8Array(wav.buffer)
mkdirSync(join(root, 'audio'), { recursive: true })
writeFileSync(join(root, 'audio', 'listen.wav'), bytes)
const kept = readFileSync(join(import.meta.dirname, 'listen.trims.json'), 'utf8')
const sha256 = createHash('sha256').update(bytes).digest('hex')
if ((JSON.parse(kept) as { source: { sha256: string } }).source.sha256 !== sha256)
  throw new Error(
    `preview/listen.trims.json was heard in another recording than this one (${sha256}): hear audio/listen.wav again, as this file's top says`,
  )
writeFileSync(join(root, 'audio', 'listen.trims.json'), kept)
