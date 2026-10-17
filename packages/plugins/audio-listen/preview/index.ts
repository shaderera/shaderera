// audio-listen: a 6 s sheet of seven takes made in code (preview/make.ts), heard by CLAP for "a
// whoosh" with the item's tools/listen.ts. Above, the recording: each take boxed with its rank,
// white where the description fits it best, its peak a red tick. Below, the film: four hit points,
// and on each the next whoosh of rank 1, placed by clipAt so its peak lands on the hit, its lead
// bracketed. The film's clips play; a line joins the playhead to the moment of the recording it
// plays.

import { readWav } from '../../audio-hall-ending/preview/signal.ts'
import { clipAt, loadTrims } from '../../previews/src/audio/trims.ts'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

/** The lanes' centre lines and half height. */
const RECORDING = 330
const FILM = 610
const HALF = 70
/** The film's hit points, in seconds. */
const HITS = [1.2, 2.6, 4.0, 5.2]

const audioListen: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`audio-listen has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const trims = await loadTrims(host, 'audio/listen.trims.json')
  const recording = await readWav(host, trims.source.path)
  const takes = trims.trims.filter((k) => k.rank === 1)
  const clips = HITS.map((hit, i) => {
    const take = takes[i % takes.length] as (typeof takes)[number]
    return { hit, take, ...clipAt(trims, take, hit) }
  })
  const mono = `"${FONT.mono}"`

  const scale = (R - L) / recording.length
  const x = (s: number) => L + s * scale
  // The waveform, once: the peak per column, on the recording's scale of seconds.
  const peaks = Float32Array.from({ length: Math.ceil(recording.length * scale) }, (_, c) => {
    const a = Math.floor((c / scale) * recording.rate)
    const b = Math.floor(((c + 1) / scale) * recording.rate)
    let m = 0
    for (let i = a; i < b; i++) m = Math.max(m, Math.abs(recording.mono[i] ?? 0))
    return m
  })
  const loud = Math.max(...peaks)
  /** Columns of the recording from `from` to `to`, drawn from `at` on the film's lane. */
  const wave = (y: number, from: number, to: number, at: number, color: string) => {
    ctx.fillStyle = color
    for (let s = from; s < to; s += 1 / scale) {
      const a = ((peaks[Math.floor(s * scale)] ?? 0) / loud) * HALF
      if (a > 0.5) ctx.fillRect(x(at + s - from), y - a, 1, 2 * a)
    }
  }
  const label = (
    text: string,
    at: number,
    y: number,
    color = '#8a8a8a',
    align: CanvasTextAlign = 'left',
  ) => {
    ctx.font = `14px ${mono}`
    ctx.textAlign = align
    ctx.fillStyle = color
    ctx.fillText(text, at, y)
  }
  const playing = (t: number) => clips.find((c) => t >= c.at && t < c.at + (c.to - c.from))
  const top: Word[] = [{ from: 0, to: duration, text: 'A WHOOSH' }]
  const bottom: Word[] = clips.map((c, i) => ({
    from: i === 0 ? 0 : c.hit,
    to: clips[i + 1]?.hit ?? duration,
    text: `PEAK +${Math.round((c.take.peak - c.take.start) * 1e3)} MS`,
  }))

  return {
    async render(t, o) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      const now = playing(t)

      // The recording: every take boxed, the ones the description fits best in white.
      label('RECORDING · 7 TAKES HEARD BY CLAP', L, RECORDING - HALF - 44)
      wave(RECORDING, 0, recording.length, 0, '#555')
      for (const k of trims.trims) {
        const best = k.rank === 1
        ctx.strokeStyle = best ? '#fff' : '#3a3a3a'
        ctx.lineWidth = best && now?.take.id === k.id ? 3 : 1
        ctx.strokeRect(x(k.start), RECORDING - HALF - 8, x(k.end) - x(k.start), 2 * HALF + 16)
        if (best) wave(RECORDING, k.start, k.end, k.start, '#fff')
        ctx.fillStyle = RED
        ctx.fillRect(x(k.peak) - 1, RECORDING + HALF + 8, 2, 12)
        label(`RANK ${k.rank}`, x(k.start) + 2, RECORDING - HALF - 16, best ? '#fff' : '#6a6a6a')
      }

      // The film: the hit points, and on each a take placed so its peak lands there.
      label('FILM · HIT POINTS', L, FILM - HALF - 44)
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.fillRect(L, FILM, R - L, 1)
      for (const c of clips) {
        const end = c.at + (c.to - c.from)
        wave(FILM, c.from, c.to, c.at, t >= c.at ? '#fff' : '#6a6a6a')
        ctx.fillStyle = RED
        ctx.fillRect(x(c.hit) - 1, FILM - HALF - 14, 2, 2 * HALF + 28)
        // The lead: from where the clip starts to its hit.
        ctx.fillStyle = '#9a9a9a'
        ctx.fillRect(x(c.at), FILM + HALF + 18, x(c.hit) - x(c.at), 1)
        ctx.fillRect(x(c.at), FILM + HALF + 12, 1, 12)
        label(`${Math.round((c.hit - c.at) * 1e3)} MS`, x(c.at), FILM + HALF + 40)
        label(c.take.id.toUpperCase(), x(end), FILM - HALF - 16, '#6a6a6a', 'right')
      }
      // The playhead, and the moment of the recording it plays.
      ctx.fillStyle = '#fff'
      ctx.fillRect(x(t) - 1, FILM - HALF - 4, 2, 2 * HALF + 8)
      if (now) {
        const source = now.from + (t - now.at)
        ctx.fillRect(x(source) - 1, RECORDING - HALF - 4, 2, 2 * HALF + 8)
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(x(source), RECORDING + HALF + 24)
        ctx.lineTo(x(t), FILM - HALF - 20)
        ctx.stroke()
      }

      house.words(top, bottom, t, o.frame)
      house.note('each take starts early by its peak’s lead')
      house.hud(
        t,
        o.frame,
        now ? `${now.take.id.toUpperCase()} → HIT ${now.hit.toFixed(1)} S` : 'BETWEEN HITS',
        'LAION CLAP · RANK 1 TAKES',
      )
      return [{ color: canvas }]
    },
    status(t) {
      const now = playing(t)
      return now ? `${now.take.id} on ${now.hit.toFixed(1)} s` : ''
    },
    inspect(t) {
      const now = playing(t)
      return { id: 'film', t, take: now?.take.id ?? null, hit: now?.hit ?? null }
    },
    async audio() {
      return clips.map(({ src, from, to, at }) => ({ src, from, to, at, group: 'fx' }))
    },
  }
}

export default audioListen
