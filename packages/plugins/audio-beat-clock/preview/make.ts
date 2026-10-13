// Synthesises the audio-beat-clock preview's music in code, so its licence is this repository's:
// four bars at 160 BPM (exactly 6 s, so it loops), kick, snare, hats, a sub bass and a lead stab
// phrase. Writes audio/beat.wav (48 kHz, 16-bit stereo), then measures it with the plugin's own
// analyser (tools/analyze-music.ts, copied in by scripts/assemble.ts) into
// audio/beat.analysis.json, as a film would measure a song. scripts/render.ts runs it.
//   node packages/plugins/audio-beat-clock/preview/make.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RATE = 48000
const BPM = 160
const STEP = 60 / BPM / 4
const BARS = 4
const LENGTH = BARS * 16 * STEP
const N = Math.round(LENGTH * RATE)

/** The lead stabs, one phrase a bar, each on a 1/16 step of its bar, with its note (MIDI). */
const STABS: { step: number; note: number }[][] = [
  [
    { step: 0, note: 69 },
    { step: 3, note: 72 },
    { step: 6, note: 76 },
    { step: 8, note: 74 },
  ],
  [
    { step: 0, note: 69 },
    { step: 4, note: 72 },
    { step: 8, note: 79 },
  ],
  [
    { step: 0, note: 65 },
    { step: 3, note: 69 },
    { step: 6, note: 72 },
    { step: 8, note: 77 },
  ],
  [
    { step: 0, note: 67 },
    { step: 4, note: 71 },
    { step: 8, note: 74 },
  ],
]
const KICK = [0, 4, 8, 12]
const SNARE = [4, 12]
const BASS_ROOT = [33, 33, 29, 31] // A1 A1 F1 G1
const BASS = [0, 6, 10, 14, 15]

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
// Deterministic noise.
let seed = 0x9e3779b9
const noise = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
  return (seed / 4294967296) * 2 - 1
}

// Two loops long, keeping the second, so tails from the end ring into the start and it loops.
const total = 2 * N
const L = new Float64Array(total)
const R = new Float64Array(total)
const duck = new Float64Array(total).fill(1)
const add = (at: number, len: number, f: (t: number, i: number) => [number, number] | number) => {
  const start = Math.round(at * RATE)
  for (let i = 0; i < len * RATE; i++) {
    const k = start + i
    if (k >= total) break
    const v = f(i / RATE, i)
    if (typeof v === 'number') {
      L[k] = (L[k] ?? 0) + v
      R[k] = (R[k] ?? 0) + v
    } else {
      L[k] = (L[k] ?? 0) + v[0]
      R[k] = (R[k] ?? 0) + v[1]
    }
  }
}

for (let loop = 0; loop < 2; loop++)
  for (let bar = 0; bar < BARS; bar++) {
    const barAt = loop * LENGTH + bar * 16 * STEP
    const at = (step: number) => barAt + step * STEP
    // Four on the floor, the downbeat accented, plus a push into bars 2 and 4.
    for (const s of bar % 2 === 1 ? [...KICK, 14] : KICK) {
      const t0 = at(s)
      const down = s === 0
      let phase = 0
      add(t0, 0.45, (t) => {
        phase += (2 * Math.PI * (44 + 130 * Math.exp(-t / 0.035))) / RATE
        const body = Math.sin(phase) * Math.exp(-t / 0.2)
        return (down ? 1 : s === 14 ? 0.45 : 0.62) * body + 0.25 * Math.exp(-t / 0.003) * noise()
      })
      const k0 = Math.round(t0 * RATE)
      for (let i = 0; i < 0.3 * RATE && k0 + i < total; i++)
        duck[k0 + i] = Math.min(duck[k0 + i] ?? 1, 1 - 0.75 * Math.exp(-i / RATE / 0.09))
    }
    const snares = bar === 3 ? [...SNARE, 13, 14, 15] : bar === 1 ? [...SNARE, 15] : SNARE
    for (const s of snares) {
      const ghost = !SNARE.includes(s)
      let hp = 0
      let last = 0
      add(at(s), 0.3, (t) => {
        const n = noise()
        hp = 0.6 * (hp + n - last)
        last = n
        const v =
          0.5 * hp * Math.exp(-t / 0.11) +
          0.35 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.06)
        return ghost ? v * 0.45 : v
      })
    }
    for (let s = 0; s < 16; s++) {
      const open = s % 4 === 2
      let a = 0
      let b = 0
      const pan = s % 2 === 0 ? 0.35 : -0.35
      add(at(s), open ? 0.22 : 0.06, (t) => {
        const n = noise()
        const hp = n - a
        const v = hp - b
        a = n
        b = hp
        const level =
          (open ? 0.09 : s % 2 === 0 ? 0.1 : 0.06) * Math.exp(-t / (open ? 0.07 : 0.018))
        return [v * level * (1 - pan), v * level * (1 + pan)]
      })
    }
    // Sub bass: a sine and a filtered saw, ducked by the kick.
    const root = BASS_ROOT[bar] ?? 33
    for (const s of BASS) {
      const t0 = at(s)
      const f = hz(root + (s === 6 || s === 14 ? 12 : 0))
      let lp = 0
      const k0 = Math.round(t0 * RATE)
      add(t0, STEP * 1.8, (t, i) => {
        const saw = 2 * ((f * t) % 1) - 1
        const cut = 0.04 + 0.25 * Math.exp(-t / 0.05)
        lp += cut * (saw - lp)
        const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.16)
        return (0.5 * Math.sin(2 * Math.PI * f * t) + 0.35 * lp) * env * (duck[k0 + i] ?? 1)
      })
    }
    // The stabs: three detuned saws through a closing filter, echoed across the field.
    for (const w of STABS[bar] ?? []) {
      const t0 = at(w.step)
      for (const [delay, gainL, gainR] of [
        [0, 1, 1],
        [3 * STEP, 0.42, 0.12],
        [6 * STEP, 0.08, 0.3],
      ] as const) {
        let lp = 0
        add(t0 + delay, 0.5, (t) => {
          const f = hz(w.note)
          let saw = 0
          for (const d of [-0.11, 0, 0.13]) saw += 2 * ((f * (1 + d / 12) * t) % 1) - 1
          saw += 0.6 * (2 * ((f * 0.5 * t) % 1) - 1)
          lp += (0.03 + 0.4 * Math.exp(-t / 0.06)) * (saw - lp)
          const v = 0.16 * lp * Math.min(1, t / 0.003) * Math.exp(-t / 0.16)
          return [v * gainL, v * gainR]
        })
      }
    }
  }

// Master: the second loop, a soft clip, a low-pass at 15 kHz (the hats' noise above it made AAC
// overshoot by 6 dB), peak at -3 dBFS.
const lowpass = (x: Float64Array) => {
  const w = (2 * Math.PI * 15000) / RATE
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  const [b0, b1, b2] = [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0]
  const [a1, a2] = [(-2 * cos) / a0, (1 - alpha) / a0]
  const y = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++)
    y[i] =
      b0 * (x[i] ?? 0) +
      b1 * (x[i - 1] ?? 0) +
      b2 * (x[i - 2] ?? 0) -
      a1 * (y[i - 1] ?? 0) -
      a2 * (y[i - 2] ?? 0)
  return y
}
const out = [L, R].map((ch) => lowpass(ch.map((v) => Math.tanh(v * 0.9))).subarray(N))
const peak = Math.max(...out.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)))
const gain = 10 ** (-3 / 20) / peak
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
for (let i = 0; i < N; i++)
  for (let c = 0; c < 2; c++)
    wav.setInt16(
      44 + i * 4 + c * 2,
      Math.round(Math.max(-1, Math.min(1, (out[c]?.[i] ?? 0) * gain)) * 32767),
      true,
    )

// The previews project, where the composition reads its audio/.
const root = join(import.meta.dirname, '..', '..', 'previews')
const dir = join(root, 'audio')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'beat.wav'), new Uint8Array(wav.buffer))
console.log(`audio/beat.wav ${LENGTH} s, ${BPM} BPM`)
// The track is 160 BPM; the default 70–180 range would also take 80.
execFileSync(
  process.execPath,
  [
    join(root, 'tools', 'analyze-music.ts'),
    'audio/beat.wav',
    '--min-bpm',
    '120',
    '--max-bpm',
    '180',
  ],
  { cwd: root, stdio: 'inherit' },
)
