// Makes the audio-hall-ending preview's sound in code, then gives it the item's ending: a short
// phrase at 120 BPM (an A minor arpeggio, F, and a held C major chord that stops dead at 2.3 s) is
// written as audio/hall-dry.wav, and the item's own tools/hall-ending.ts sends its last chord into
// the hall, so audio/hall-end.wav rings out and is digital silence for the last second of the 6 s
// loop. audio/hall.json records the ending's numbers for the picture. Run after scripts/assemble.ts
// (scripts/render.ts does both).
//   node packages/plugins/audio-hall-ending/preview/make.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RATE = 48000
const STEP = 0.125 // a 16th at 120 BPM
/** The song stops dead here: the end of the dry file. */
const END = 2.3
/** The hall opens just before the last chord. */
const SEND = 1.45
const RT = 2.8
const WET = 30
const DURATION = 6
const N = Math.round(END * RATE)

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
let seed = 0x2545f491
const noise = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
  return (seed / 4294967296) * 2 - 1
}
const L = new Float64Array(N)
const R = new Float64Array(N)
const add = (at: number, len: number, f: (t: number) => number | [number, number]) => {
  const start = Math.round(at * RATE)
  for (let i = 0; i < len * RATE; i++) {
    const k = start + i
    if (k >= N) break
    const v = f(i / RATE)
    const [l, r] = typeof v === 'number' ? [v, v] : v
    L[k] = (L[k] ?? 0) + l
    R[k] = (R[k] ?? 0) + r
  }
}
const saw = (f: number, t: number) => 2 * ((f * t) % 1) - 1

/** Chord tones per 16th: A minor for a bar, F for half, and the last chord C major from 1.5 s. */
const CHORDS = [
  { from: 0, notes: [57, 60, 64], root: 33 },
  { from: 8, notes: [53, 57, 60], root: 29 },
  { from: 12, notes: [60, 64, 67], root: 36 },
]
const chordAt = (step: number) =>
  [...CHORDS].reverse().find((c) => step >= c.from) ?? (CHORDS[0] as (typeof CHORDS)[number])

// The arpeggio: a plucked saw through a closing filter, up two octaves of chord tones.
for (let s = 0; s < 12; s++) {
  const c = chordAt(s)
  const note = (c.notes[s % 3] ?? 60) + 12 * (Math.floor(s / 3) % 2)
  const pan = s % 2 === 0 ? 0.3 : -0.3
  let lp = 0
  add(s * STEP, 0.4, (t) => {
    const x = saw(hz(note), t) + 0.5 * saw(hz(note) * 1.005, t)
    lp += (0.02 + 0.5 * Math.exp(-t / 0.05)) * (x - lp)
    const v = 0.2 * lp * Math.min(1, t / 0.002) * Math.exp(-t / 0.18)
    return [v * (1 - pan), v * (1 + pan)]
  })
}
// The pad under it, and the last chord: wide detuned saws that hold at full level to the end.
for (const c of CHORDS) {
  const at = c.from * STEP
  const last = c === CHORDS[2]
  const len = last ? END - at : (c === CHORDS[0] ? 8 : 4) * STEP
  const voices = last ? [...c.notes, (c.notes[0] ?? 60) + 12, (c.notes[1] ?? 64) + 12] : c.notes
  for (const [v, note] of voices.entries()) {
    let lpL = 0
    let lpR = 0
    add(at, len, (t) => {
      const f = hz(note)
      const a = saw(f * (1 - 0.003), t) + saw(f * 1.002, t)
      const b = saw(f * (1 + 0.004), t) + saw(f * 0.999, t)
      const cut = last ? 0.08 + 0.3 * Math.exp(-t / 0.12) : 0.035
      lpL += cut * (a - lpL)
      lpR += cut * (b - lpR)
      const env = Math.min(1, t / (last ? 0.004 : 0.03)) * (last ? 1 : Math.exp(-t / 1.2))
      const g = (last ? 0.07 : 0.045) * env * (1 - v * 0.08)
      return [lpL * g, lpR * g]
    })
  }
  // The bass: a sine and a little filtered saw on the chord's root.
  let lp = 0
  add(at, len, (t) => {
    const f = hz(c.root)
    lp += 0.05 * (saw(f, t) - lp)
    const env = Math.min(1, t / 0.005) * (last ? 1 : 0.6 + 0.4 * Math.exp(-t / 0.2))
    return (0.32 * Math.sin(2 * Math.PI * f * t) + 0.2 * lp) * env
  })
}
// Drums: a kick on every beat, eighth hats, and a crash with the last chord.
for (const b of [0, 4, 8, 12]) {
  let phase = 0
  add(b * STEP, 0.4, (t) => {
    phase += (2 * Math.PI * (46 + 120 * Math.exp(-t / 0.03))) / RATE
    return (b === 12 ? 0.9 : 0.7) * Math.sin(phase) * Math.exp(-t / 0.18)
  })
}
for (let s = 0; s < 12; s += 2) {
  let a = 0
  add(s * STEP, 0.08, (t) => {
    const n = noise()
    const v = n - a
    a = n
    return v * 0.07 * Math.exp(-t / 0.02)
  })
}
{
  let a = 0
  add(12 * STEP, END, (t) => {
    const n = noise()
    const v = n - a
    a = n
    return [v * 0.11 * Math.exp(-t / 0.9), (noise() - a * 0.5) * 0.08 * Math.exp(-t / 0.9)]
  })
}

// Master: a soft clip, a low-pass at 15 kHz (the crash's noise above it makes AAC overshoot), the
// peak at -5 dBFS (AAC overshoots the attacks), 16-bit stereo. It ends on the chord at full level.
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
const out = [L, R].map((ch) => lowpass(ch.map((v) => Math.tanh(v * 1.1))))
const peak = Math.max(...out.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)))
const gain = 10 ** (-5 / 20) / peak
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
mkdirSync(join(root, 'audio'), { recursive: true })
writeFileSync(join(root, 'audio', 'hall-dry.wav'), new Uint8Array(wav.buffer))
// The item, as a film would run it.
const tool = join(root, 'tools', 'hall-ending.ts')
const args = ['--in', 'audio/hall-dry.wav', '--out', 'audio/hall-end.wav']
const opts = ['--send', String(SEND), '--rt', String(RT), '--wet', String(WET)]
execFileSync(process.execPath, [tool, ...args, ...opts, '--duration', String(DURATION)], {
  cwd: root,
  stdio: 'inherit',
})
// The tool's defaults for the fade, as it computes them.
const ending = {
  send: SEND,
  end: END,
  rt: RT,
  wet: WET,
  quiet: END + 0.7 * RT,
  gone: END + 0.95 * RT,
  duration: DURATION,
}
writeFileSync(join(root, 'audio', 'hall.json'), `${JSON.stringify(ending, null, 2)}\n`)
console.log('audio/hall-dry.wav, audio/hall-end.wav, audio/hall.json')
