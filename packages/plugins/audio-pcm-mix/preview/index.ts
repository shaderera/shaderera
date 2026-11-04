// audio-pcm-mix: eight plucks made in code, each a decaying sine with a click of the plugin's
// seeded noise, added to one stereo buffer every 0.75 s with add(), the pan stepping from left to
// right and back. The picture is that buffer: the pan line with every pluck's place on it, the
// gain each side gets (-3 dB at the centre, all on one side at ±1), and the left and right
// channels as waveforms, the sounding pluck in white. The buffer plays as the preview's sound, and
// check()'s numbers stand in the HUD.

import { add, check, mixBuffer, noise, toPcm } from '../../previews/src/audio/mix.ts'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const RATE = 48000
const STEP = 0.75
const PANS = [-1, -0.5, 0, 0.5, 1, 0.5, 0, -0.5]
const GAIN = 0.3
/** The pan line, and the left and right lanes' centre lines and half height. */
const PAN_Y = 220
const LANES = [450, 640]
const HALF = 72

const fmt = (x: number, digits = 2) =>
  `${x < 0 ? '−' : x > 0 ? '+' : ''}${Math.abs(x).toFixed(digits)}`
const db = (x: number) => (x <= 0 ? '−∞' : fmt(20 * Math.log10(x), 1))

const audioPcmMix: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`audio-pcm-mix has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The sound: one pluck, placed eight times.
  const buf = mixBuffer({ duration, sampleRate: RATE, channels: 2 })
  const hiss = noise(host.seed)
  const pluck = Float32Array.from({ length: Math.round(0.7 * RATE) }, (_, j) => {
    const s = j / RATE
    const tone =
      (Math.sin(2 * Math.PI * 440 * s) + 0.4 * Math.sin(2 * Math.PI * 880 * s)) * Math.exp(-s * 6)
    return tone * Math.min(1, j / 48) + (j < 240 ? hiss() * (1 - j / 240) : 0)
  })
  const hits = PANS.map((pan, k) => ({ at: k * STEP, pan }))
  for (const h of hits) add(buf, pluck, h.at, { gain: GAIN, pan: h.pan })
  const level = check(buf)
  const [left, right] = buf.channels as [Float32Array, Float32Array]

  // The waveforms, once: the peak per column.
  const columns = R - L
  const peaks = [left, right].map((ch) =>
    Float32Array.from({ length: columns }, (_, c) => {
      let m = 0
      for (
        let i = Math.floor((c / columns) * ch.length);
        i < Math.floor(((c + 1) / columns) * ch.length);
        i++
      )
        m = Math.max(m, Math.abs(ch[i] ?? 0))
      return m
    }),
  )
  const xOf = (s: number) => L + (s / duration) * columns
  const panX = (p: number) => L + ((p + 1) / 2) * columns
  const hitAt = (t: number) => Math.min(hits.length - 1, Math.floor(t / STEP))

  const label = (
    text: string,
    x: number,
    y: number,
    color = '#8a8a8a',
    align: CanvasTextAlign = 'left',
  ) => {
    ctx.font = `14px ${mono}`
    ctx.textAlign = align
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
  }
  const bottom: Word[] = hits.map((h, k) => ({
    from: h.at,
    to: (k + 1) * STEP,
    text: fmt(h.pan, 1),
  }))

  return {
    async render(t, o) {
      const k = hitAt(t)
      const hit = hits[k] as (typeof hits)[number]
      const gl = Math.sqrt((1 - hit.pan) / 2)
      const gr = Math.sqrt((1 + hit.pan) / 2)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      // The pan line: every pluck's place, the sounding one in red.
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(L, PAN_Y, columns, 1)
      for (const p of [-1, -0.5, 0, 0.5, 1]) {
        ctx.fillRect(panX(p), PAN_Y - 6, 1, 13)
        label(
          p === -1 ? '−1 LEFT' : p === 1 ? '+1 RIGHT' : fmt(p, 1),
          panX(p),
          PAN_Y + 26,
          '#8a8a8a',
          p === -1 ? 'left' : p === 1 ? 'right' : 'center',
        )
      }
      ctx.fillStyle = RED
      ctx.beginPath()
      ctx.arc(panX(hit.pan), PAN_Y, 9, 0, 2 * Math.PI)
      ctx.fill()

      // The gain each side gets, as bars from the left edge.
      for (const [i, [name, g]] of (
        [
          ['LEFT', gl],
          ['RIGHT', gr],
        ] as const
      ).entries()) {
        const y = 280 + i * 30
        ctx.fillStyle = 'rgba(255,255,255,0.15)'
        ctx.fillRect(L + 90, y - 10, columns - 300, 10)
        ctx.fillStyle = '#fff'
        ctx.fillRect(L + 90, y - 10, (columns - 300) * g, 10)
        label(name, L, y, '#fff')
        label(`× ${g.toFixed(3)}   ${db(g)} DB`, R, y, '#fff', 'right')
      }

      // The two channels, the sounding pluck white, the playhead and each pluck's start.
      const from = xOf(hit.at)
      const to = xOf(hit.at + STEP)
      for (const [i, y] of LANES.entries()) {
        const col = peaks[i] as Float32Array
        for (let c = 0; c < col.length; c++) {
          const a = Math.min(1, (col[c] ?? 0) / GAIN) * HALF
          if (a <= 0) continue
          ctx.fillStyle = L + c >= from && L + c < to ? '#fff' : '#4a4a4a'
          ctx.fillRect(L + c, y - a, 1, 2 * a)
        }
        ctx.fillStyle = 'rgba(255,255,255,0.25)'
        ctx.fillRect(L, y, columns, 1)
        for (const [j, h] of hits.entries()) {
          ctx.fillStyle = j === k ? RED : '#6a6a6a'
          ctx.fillRect(xOf(h.at), y - HALF - 14, 2, 8)
        }
        label(i === 0 ? 'LEFT' : 'RIGHT', L, y - HALF - 22)
        ctx.fillStyle = '#fff'
        ctx.fillRect(xOf(t) - 1, y - HALF - 4, 2, 2 * HALF + 8)
      }

      house.words([{ from: 0, to: duration, text: 'PAN' }], bottom, t, o.frame)
      house.note('each side −3 dB at the centre, all of it on one side at −1 or +1')
      house.hud(
        t,
        o.frame,
        `AT ${hit.at.toFixed(2)} S → SAMPLE ${Math.round(hit.at * RATE)}`,
        `PEAK ${db(level.peak)} DBFS   DC ${level.dc.map((d) => fmt(d, 5)).join(' ')}   NAN/INF ${level.nonFinite}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return `pan ${fmt((hits[hitAt(t)] as (typeof hits)[number]).pan, 1)}`
    },
    inspect(t) {
      const hit = hits[hitAt(t)] as (typeof hits)[number]
      return { id: 'mix', at: hit.at, sample: Math.round(hit.at * RATE), pan: hit.pan, ...level }
    },
    async audio() {
      return [{ pcm: toPcm(buf), at: buf.start }]
    },
  }
}

export default audioPcmMix
