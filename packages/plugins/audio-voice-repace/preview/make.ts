// Makes the audio-voice-repace preview's narration in code, then re-paces it with the item's own
// tool: ten voice-like words (a buzzing glottal pulse through two vowel formants, its pitch
// falling over each phrase) in three phrases, 7.5 s long, with a 1.3 s and a 0.9 s pause the tool
// shortens and a 1.1 s pause it keeps. Writes audio/voice.wav and its words as a speech-to-text
// transcript (audio/voice.words.json), then runs tools/voice-repace.ts, which writes
// audio/voice-paced.wav and audio/voice-paced.map.json. Run after scripts/assemble.ts
// (scripts/render.ts does both).
//   node packages/plugins/audio-voice-repace/preview/make.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RATE = 48000
const LENGTH = 7.5
/** The words, in seconds of the recording, and each word's vowel as two formants in Hz. */
const WORDS: [number, number, string, number, number][] = [
  [0.25, 0.62, 'every', 530, 1840],
  [0.7, 1.1, 'pause', 730, 1090],
  [1.18, 1.42, 'ran', 660, 1720],
  [1.5, 1.95, 'long', 570, 840],
  [3.25, 3.45, 'so', 450, 900],
  [3.52, 3.68, 'the', 500, 1500],
  [3.76, 4.2, 'tool', 300, 870],
  [5.3, 5.7, 'cuts', 640, 1190],
  [6.6, 6.75, 'the', 500, 1500],
  [6.82, 7.3, 'middle', 390, 1990],
]
/** A time inside the pause to keep, the longest a pause may stay, and the new speed. */
const KEEP = 4.7
const MAX_PAUSE = 0.3
const TEMPO = 1.1

const N = Math.round(LENGTH * RATE)
const voice = new Float64Array(N)
/** A two-pole resonator's coefficients: a formant at f Hz, `bw` Hz wide. */
const resonator = (f: number, bw: number) => {
  const r = Math.exp((-Math.PI * bw) / RATE)
  return { a1: 2 * r * Math.cos((2 * Math.PI * f) / RATE), a2: -r * r, g: 1 - r }
}
for (const [w, [start, end, , f1, f2]] of WORDS.entries()) {
  const phrase = start < 3 ? 0 : start < 5 ? 1 : 2
  const r1 = resonator(f1, 90)
  const r2 = resonator(f2, 120)
  let y1 = [0, 0]
  let y2 = [0, 0]
  let phase = 0
  const from = Math.round(start * RATE)
  const to = Math.round(end * RATE)
  for (let i = from; i < to; i++) {
    const t = (i - from) / RATE
    const len = end - start
    // The pitch falls over each word and lower across the phrase, as a sentence does.
    const f0 = 150 - phrase * 6 - (w % 4) * 4 - 18 * (t / len)
    phase = (phase + f0 / RATE) % 1
    const pulse = phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) ** 2 : 0
    const a = r1.g * pulse + r1.a1 * (y1[0] ?? 0) + r1.a2 * (y1[1] ?? 0)
    const b = r2.g * pulse + r2.a1 * (y2[0] ?? 0) + r2.a2 * (y2[1] ?? 0)
    y1 = [a, y1[0] ?? 0]
    y2 = [b, y2[0] ?? 0]
    const env =
      Math.min(1, t / 0.012, (len - t) / 0.04) * (0.75 + 0.25 * Math.sin(Math.PI * (t / len)))
    voice[i] = env * (a + 0.6 * b)
  }
}
const peak = voice.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
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
for (let i = 0; i < N; i++)
  wav.setInt16(44 + i * 2, Math.round((voice[i] ?? 0) * gain * 32767), true)

// The previews project, where the composition reads its audio/.
const root = join(import.meta.dirname, '..', '..', 'previews')
mkdirSync(join(root, 'audio'), { recursive: true })
writeFileSync(join(root, 'audio', 'voice.wav'), new Uint8Array(wav.buffer))
const words = WORDS.map(([start, end, word]) => ({ start, end, text: word }))
const transcript = { text: words.map((w) => w.text).join(' '), words }
writeFileSync(join(root, 'audio', 'voice.words.json'), `${JSON.stringify(transcript, null, 2)}\n`)
// The item, as a film would run it.
execFileSync(
  process.execPath,
  [
    join(root, 'tools', 'voice-repace.ts'),
    ...['audio/voice.wav', 'audio/voice.words.json', '--out', 'audio/voice-paced.wav'],
    ...['--max-pause', String(MAX_PAUSE), '--keep', String(KEEP), '--tempo', String(TEMPO)],
  ],
  { cwd: root, stdio: 'inherit' },
)
