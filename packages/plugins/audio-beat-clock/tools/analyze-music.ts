// Measures a song so the picture can be cut to it:
//   node tools/analyze-music.ts <song> [out.json] [--fps 60] [--min-bpm 70] [--max-bpm 180]
// Writes (by default next to the song, as <song>.analysis.json) the tempo and beat grid, the
// downbeats, onsets with their strength, band energy every film frame (sub, low, mid, high),
// silences and section boundaries. The song's sha256 is recorded, so the film can refuse an
// analysis of other bytes (src/music/beat.ts, loadAnalysis). Measurements only: what they mean is
// decided in the film's code. Needs ffmpeg on PATH.
//
// The tempo is found by autocorrelation, then fitted to the song's strong onsets (fitGrid), so the
// grid does not drift over a long song. Check it by ear: autocorrelation can land on a ratio of
// the real one (100 for 150). Narrow --min-bpm/--max-bpm around what you hear and run it again.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fitGrid } from '../src/music/beat.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fps: { type: 'string', default: '60' },
    'min-bpm': { type: 'string', default: '70' },
    'max-bpm': { type: 'string', default: '180' },
  },
})
const src = positionals[0]
if (!src) throw new Error('Usage: node tools/analyze-music.ts <song> [out.json] [--fps 60]')
const outPath = positionals[1] ?? src.replace(/\.[^./\\]+$/, '') + '.analysis.json'
const FPS = Number(values.fps)
const MIN_BPM = Number(values['min-bpm'])
const MAX_BPM = Number(values['max-bpm'])
const RATE = 48000

const bytes = readFileSync(src)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const raw = execFileSync(
  'ffmpeg',
  ['-v', 'error', '-i', src, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
  { maxBuffer: 1 << 30 },
)
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const duration = x.length / RATE
const sample = (i: number) => x[i] ?? 0

// Short-time spectra: hop 1/240 s, Hann window of 2048.
const N = 2048
const HOP = RATE / 240
const frames = Math.floor((x.length - N) / HOP)
const re = new Float64Array(N)
const im = new Float64Array(N)
const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
const fft = () => {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j] as number, re[i] as number]
      ;[im[i], im[j]] = [im[j] as number, im[i] as number]
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const a = (-2 * Math.PI) / len
    for (let i = 0; i < N; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k)
        const wi = Math.sin(a * k)
        const p = i + k
        const q = p + len / 2
        const ur = re[p] as number
        const ui = im[p] as number
        const vr = (re[q] as number) * wr - (im[q] as number) * wi
        const vi = (re[q] as number) * wi + (im[q] as number) * wr
        re[p] = ur + vr
        im[p] = ui + vi
        re[q] = ur - vr
        im[q] = ui - vi
      }
  }
}
const binHz = RATE / N
const BANDS = { sub: [20, 90], low: [90, 300], mid: [300, 3000], high: [3000, 16000] } as const
type Band = keyof typeof BANDS
const bandNames = Object.keys(BANDS) as Band[]
const energy = Object.fromEntries(bandNames.map((b) => [b, new Float64Array(frames)])) as Record<
  Band,
  Float64Array
>
const flux = new Float64Array(frames)
const rms = new Float64Array(frames)
let prev = new Float64Array(N / 2)
for (let f = 0; f < frames; f++) {
  const o = Math.round(f * HOP)
  let s = 0
  for (let i = 0; i < N; i++) {
    const v = sample(o + i)
    re[i] = v * (win[i] as number)
    im[i] = 0
    s += v * v
  }
  rms[f] = Math.sqrt(s / N)
  fft()
  const mag = new Float64Array(N / 2)
  let fl = 0
  for (let k = 1; k < N / 2; k++) {
    const r = re[k] as number
    const m = im[k] as number
    mag[k] = Math.log1p(1000 * Math.hypot(r, m))
    fl += Math.max(0, (mag[k] as number) - (prev[k] as number))
    const hz = k * binHz
    for (const b of bandNames)
      if (hz >= BANDS[b][0] && hz < BANDS[b][1])
        energy[b][f] = (energy[b][f] as number) + r * r + m * m
  }
  flux[f] = fl
  prev = mag
}
const at = (f: number) => (f * HOP + N / 2) / RATE
const fl = (f: number) => flux[f] ?? 0

// Onsets: peaks of spectral flux above a moving median, at least 45 ms apart.
const onsets: { t: number; strength: number }[] = []
const W = 24
for (let f = W; f < frames - W; f++) {
  const local = Array.from(flux.subarray(f - W, f + W)).sort((a, b) => a - b)
  const median = local[W] as number
  const peak = fl(f) >= fl(f - 1) && fl(f) > fl(f + 1) && fl(f) > median * 1.5 + 20
  const last = onsets.at(-1)
  if (peak && (!last || at(f) - last.t > 0.045))
    onsets.push({ t: Number(at(f).toFixed(4)), strength: Number((fl(f) - median).toFixed(1)) })
}

// Tempo: autocorrelation of the onset envelope over the BPM range, then the phase that fits best.
const env = Array.from(flux, (v, f) => Math.max(0, v - (flux[f - 1] ?? v)))
const e = (f: number) => env[f] ?? 0
let best = { bpm: 0, score: -1 }
for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.05) {
  const lag = (60 / bpm) * 240
  let s = 0
  for (let f = 0; f + lag * 4 < frames; f++)
    s +=
      e(f) *
      (e(Math.round(f + lag)) +
        0.5 * e(Math.round(f + 2 * lag)) +
        0.25 * e(Math.round(f + 4 * lag)))
  if (s > best.score) best = { bpm, score: s }
}
const rough = 60 / best.bpm
let phase = 0
let phaseScore = -1
for (let p = 0; p < rough; p += 1 / 1000) {
  let s = 0
  for (const o of onsets) {
    const d = ((((o.t - p) / rough) % 1) + 1) % 1
    s += o.strength * Math.exp(-((Math.min(d, 1 - d) * rough) ** 2) / (2 * 0.012 ** 2))
  }
  if (s > phaseScore) {
    phaseScore = s
    phase = p
  }
}
// The grid from the song's own hits: autocorrelation is only as fine as its 0.05 BPM step.
const fit = fitGrid(onsets, { period: rough, phase })
const period = fit.period
phase = fit.phase
const bpm = 60 / period
const beats: number[] = []
for (let t = phase; t < duration; t += period) beats.push(Number(t.toFixed(4)))
// The downbeat: the beat class (of 4) that carries the most sub-band energy.
const subAt = (t: number) =>
  energy.sub[Math.max(0, Math.min(frames - 1, Math.round(t * 240 - N / 2 / HOP)))] ?? 0
const classScore = [0, 0, 0, 0]
beats.forEach((t, i) => {
  classScore[i % 4] = (classScore[i % 4] as number) + Math.log1p(subAt(t))
})
const downbeatClass = classScore.indexOf(Math.max(...classScore))
const downbeats = beats.filter((_, i) => i % 4 === downbeatClass)

// Per film frame: band energy in dB below that band's loudest frame.
const perFrame = Math.floor(duration * FPS)
const bands = Object.fromEntries(
  bandNames.map((b) => {
    const en = energy[b]
    const max = en.reduce((m, v) => Math.max(m, v), 0)
    return [
      b,
      Array.from({ length: perFrame }, (_, i) => {
        const f = Math.min(frames - 1, Math.max(0, Math.round((i / FPS) * 240 - N / 2 / HOP)))
        return Number((10 * Math.log10((en[f] as number) / max + 1e-12)).toFixed(1))
      }),
    ]
  }),
)

// Silences: 40 ms or more under -40 dB below the song's peak RMS.
const peak = rms.reduce((m, v) => Math.max(m, v), 0)
const silences: { from: number; to: number }[] = []
let start = -1
for (let f = 0; f < frames; f++) {
  const quiet = 20 * Math.log10((rms[f] as number) / peak + 1e-12) < -40
  if (quiet && start < 0) start = f
  if ((!quiet || f === frames - 1) && start >= 0) {
    if (at(f) - at(start) >= 0.04)
      silences.push({ from: Number(at(start).toFixed(3)), to: Number(at(f).toFixed(3)) })
    start = -1
  }
}

// Sections: novelty of the band profile (1.2 s either side); the strongest peaks, 1.5 s apart.
const profile = (f: number) => bandNames.map((b) => Math.log10((energy[b][f] ?? 0) + 1e-9))
const novelty: { t: number; v: number }[] = []
const span = 240 * 1.2
for (let f = span; f < frames - span; f += 6) {
  const a = [0, 0, 0, 0]
  const b = [0, 0, 0, 0]
  for (let k = 0; k < span; k += 4) {
    profile(f - k).forEach((v, i) => {
      a[i] = (a[i] as number) + v
    })
    profile(f + k).forEach((v, i) => {
      b[i] = (b[i] as number) + v
    })
  }
  novelty.push({ t: at(f), v: Math.hypot(...a.map((v, i) => (v - (b[i] as number)) / (span / 4))) })
}
const sections = novelty
  .filter((n, i) => {
    const before = novelty[i - 1]
    const after = novelty[i + 1]
    return before !== undefined && after !== undefined && n.v > before.v && n.v >= after.v
  })
  .sort((a, b) => b.v - a.v)
  .reduce<{ t: number; v: number }[]>(
    (kept, n) => (kept.every((k) => Math.abs(k.t - n.t) > 1.5) ? [...kept, n] : kept),
    [],
  )
  .slice(0, 12)
  .sort((a, b) => a.t - b.t)
  .map((n) => ({ t: Number(n.t.toFixed(3)), novelty: Number(n.v.toFixed(2)) }))

const out = {
  kind: 'shaderera.analysis/1',
  of: { path: src.replace(/\\/g, '/'), sha256 },
  duration: Number(duration.toFixed(4)),
  tempo: {
    bpm: Number(bpm.toFixed(3)),
    period: Number(period.toFixed(6)),
    phase: Number(phase.toFixed(4)),
    downbeatClass,
    fit: {
      from: Number(best.bpm.toFixed(2)),
      subdivision: fit.subdivision,
      onsets: fit.onsets,
      residualMs: Number(fit.residualMs.toFixed(1)),
    },
  },
  beats,
  downbeats,
  onsets,
  silences,
  sections,
  bands: { fps: FPS, unit: 'dB below the band peak', ...bands },
}
writeFileSync(outPath, `${JSON.stringify(out)}\n`)
console.log(`${outPath}`)
console.log(
  `${src}: ${duration.toFixed(3)} s, ${bpm.toFixed(3)} BPM (autocorrelation ${best.bpm.toFixed(2)}; fitted to ${fit.onsets} onsets on 1/${fit.subdivision} beats, median ${fit.residualMs.toFixed(1)} ms off the grid), phase ${phase.toFixed(3)} s, first downbeat ${downbeats[0]?.toFixed(3)} s`,
)
console.log(`onsets ${onsets.length}, silences ${JSON.stringify(silences)}`)
console.log(`sections ${sections.map((s) => s.t).join(', ')}`)
