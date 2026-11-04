// audio-filters: eight filters in turn, 0.75 s each, every one the plugin's call. The picture is
// each filter's response as measured here, a sine at each of 96 frequencies run through it, on a
// log axis from 20 Hz to 20 kHz; a cursor sweeps up it and reads the gain, and a red marker gives
// the gain measured at the filter's own frequency. The sound is seeded noise through that filter,
// each segment filtered in one call and ended with tailFade.

import { type Biquad, biquad, hz, onePole, tailFade } from '../../previews/src/audio/filters.ts'
import { createHouse, L, R, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const RATE = 48000
const SEG = 0.75
const POINTS = 96
const LO = 20
const HI = 20000
/** The graph: its top and bottom in pixels, and the dB at each. */
const TOP = 190
const BOTTOM = 700
const DB_TOP = 15
const DB_BOTTOM = -45

type Filter = { name: string; call: string; freq: number; apply: (x: Float32Array) => void }
const bq = (name: string, f: Biquad, call: string): Filter => ({
  name,
  call: `biquad(x, { type: '${f.type}', freq: ${call}, q: ${+f.q.toFixed(3)}${'gainDb' in f ? `, gainDb: ${f.gainDb}` : ''} }, ${RATE})`,
  freq: f.freq,
  apply: (x) => biquad(x, f, RATE),
})
const FILTERS: Filter[] = [
  {
    name: 'ONE-POLE',
    call: `onePole(x, 1000, ${RATE})`,
    freq: 1000,
    apply: (x) => onePole(x, 1000, RATE),
  },
  bq('LOW-PASS', { type: 'lowpass', freq: 1000, q: Math.SQRT1_2 }, '1000'),
  bq('HIGH-PASS', { type: 'highpass', freq: 1000, q: Math.SQRT1_2 }, '1000'),
  bq('BAND-PASS', { type: 'bandpass', freq: hz(81), q: 4 }, 'hz(81)'),
  bq('NOTCH', { type: 'notch', freq: hz(81), q: 0.7 }, 'hz(81)'),
  bq('PEAK', { type: 'peak', freq: hz(93), q: 2, gainDb: 12 }, 'hz(93)'),
  bq('LOW SHELF', { type: 'lowshelf', freq: 250, q: Math.SQRT1_2, gainDb: 9 }, '250'),
  bq('HIGH SHELF', { type: 'highshelf', freq: 3000, q: Math.SQRT1_2, gainDb: -15 }, '3000'),
]

/** The gain in dB at `freq`: a sine run through the filter, settled, its amplitude at `freq`. */
const gainAt = (f: Filter, freq: number) => {
  const settle = Math.round(0.1 * RATE)
  const n = Math.round((Math.max(4, Math.ceil(0.02 * freq)) * RATE) / freq)
  const w = (2 * Math.PI * freq) / RATE
  const x = Float32Array.from({ length: settle + n }, (_, i) => 0.03 * Math.sin(w * i))
  f.apply(x)
  let re = 0
  let im = 0
  for (let i = settle; i < settle + n; i++) {
    re += (x[i] as number) * Math.cos(w * i)
    im += (x[i] as number) * Math.sin(w * i)
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / n / 0.03)
}

const freqAt = (p: number) => LO * (HI / LO) ** p
const xOf = (freq: number) => L + (Math.log(freq / LO) / Math.log(HI / LO)) * (R - L)
const yOf = (db: number) =>
  TOP +
  ((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * (BOTTOM - TOP)
const dB = (g: number) => (g < -60 ? '−∞' : `${g < 0 ? '−' : '+'}${Math.abs(g).toFixed(1)}`)

const audioFilters: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`audio-filters has no state "${stateId}"`)
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // Measured once: each filter's curve, and its gain at its own frequency.
  const curves = FILTERS.map((f) =>
    Float64Array.from({ length: POINTS }, (_, i) => gainAt(f, freqAt(i / (POINTS - 1)))),
  )
  const atFreq = FILTERS.map((f) => gainAt(f, f.freq))

  // The sound: seeded noise through each filter in one call, its tail faded, the whole at -6 dBFS.
  let seed = 0x2545f491
  const noise = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 2147483648 - 1
  }
  const len = Math.round(SEG * RATE)
  const sound = new Float32Array(len * FILTERS.length)
  FILTERS.forEach((f, k) => {
    const x = Float32Array.from({ length: len }, () => 0.2 * noise())
    f.apply(x)
    sound.set(tailFade(x, 0.01, RATE), k * len)
  })
  const peak = sound.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  for (let i = 0; i < sound.length; i++) sound[i] = ((sound[i] as number) * 0.5) / peak

  const state = (t: number) => {
    const k = Math.min(FILTERS.length - 1, Math.floor(t / SEG))
    const p = (t - k * SEG) / SEG
    const curve = curves[k] as Float64Array
    const at = p * (POINTS - 1)
    const i = Math.min(POINTS - 2, Math.floor(at))
    const g = (curve[i] as number) + ((curve[i + 1] as number) - (curve[i] as number)) * (at - i)
    return { k, f: FILTERS[k] as Filter, p, curve, cursor: freqAt(p), gain: g }
  }

  const drawGrid = () => {
    ctx.font = `12px ${mono}`
    ctx.textAlign = 'left'
    for (let db = DB_TOP; db >= DB_BOTTOM; db -= 15) {
      ctx.fillStyle = db === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)'
      ctx.fillRect(L, Math.round(yOf(db)), R - L, 1)
      ctx.fillStyle = '#6a6a6a'
      ctx.fillText(`${db > 0 ? '+' : ''}${db} DB`, L + 4, yOf(db) - 5)
    }
    for (const [freq, label] of [
      [20, '20 HZ'],
      [100, '100'],
      [1000, '1 K'],
      [10000, '10 K'],
      [20000, '20 KHZ'],
    ] as const) {
      const x = Math.round(xOf(freq))
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(Math.min(x, R - 1), BOTTOM + 12, 1, 8)
      ctx.fillStyle = '#8a8a8a'
      ctx.textAlign = freq === LO ? 'left' : freq === HI ? 'right' : 'center'
      ctx.fillText(label, x, BOTTOM + 36)
    }
  }

  const drawCurve = (curve: Float64Array, upTo: number, color: string, after: string) => {
    ctx.lineWidth = 3
    for (let i = 1; i < POINTS; i++) {
      ctx.strokeStyle = i / (POINTS - 1) <= upTo ? color : after
      ctx.beginPath()
      ctx.moveTo(xOf(freqAt((i - 1) / (POINTS - 1))), yOf(curve[i - 1] as number))
      ctx.lineTo(xOf(freqAt(i / (POINTS - 1))), yOf(curve[i] as number))
      ctx.stroke()
    }
  }

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      drawGrid()
      drawCurve(s.curve, s.p, '#fff', '#555')
      // The filter's own frequency and the gain measured there.
      const fx = Math.round(xOf(s.f.freq))
      ctx.fillStyle = RED
      ctx.fillRect(fx - 1, TOP - 20, 2, BOTTOM - TOP + 20)
      ctx.font = `13px ${mono}`
      ctx.textAlign = fx > (L + R) / 2 ? 'right' : 'left'
      ctx.fillText(
        `${dB(atFreq[s.k] as number)} DB AT ${s.f.freq.toFixed(1)} HZ`,
        fx + (fx > (L + R) / 2 ? -8 : 8),
        TOP - 8,
      )
      // The cursor, reading the curve.
      const cx = xOf(s.cursor)
      ctx.fillStyle = '#fff'
      ctx.fillRect(Math.round(cx) - 1, TOP, 2, BOTTOM - TOP)
      ctx.beginPath()
      ctx.arc(cx, yOf(s.gain), 7, 0, 2 * Math.PI)
      ctx.fill()
      const since = t - s.k * SEG
      const until = (s.k + 1) * SEG - t
      house.bigWord({ text: s.f.name, corner: 'tl', since, until, frame: o.frame, maxWidth: 700 })
      house.bigWord({ text: `${dB(s.gain)} DB`, corner: 'br', since: 9, frame: o.frame })
      house.note(`noise through it; the curve measured with sines`)
      house.hud(t, o.frame, s.f.call, `${Math.round(s.cursor)} HZ   ${dB(s.gain)} DB`)
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${s.f.name.toLowerCase()} ${dB(s.gain)} dB`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'filter', name: s.f.name, freq: s.f.freq, gainAtFreq: atFreq[s.k] ?? null }
    },
    async audio() {
      return [{ pcm: { sampleRate: RATE, channels: [sound] }, at: 0 }]
    },
  }
}

export default audioFilters
