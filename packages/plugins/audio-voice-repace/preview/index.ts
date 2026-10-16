// audio-voice-repace: a narration made in code (preview/make.ts), 7.5 s with two long pauses and
// one meant pause, re-paced by the item's tools/voice-repace.ts. The picture is the two files it
// read and wrote, on one scale of seconds: the original above, with the stretches the tool cut out
// boxed and the kept pause marked, the paced file below, and between them the time map, a line
// from each word's start to where it went. The paced file plays; its playhead and the original
// time it came from are joined by a line.

import { readWav, type Signal } from '../../audio-hall-ending/preview/signal.ts'
import { loadTimeMap, pacedTime } from '../../previews/src/audio/repace.ts'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { loadTimedText } from '../../previews/src/type/timed-text.ts'

/** The lanes' centre lines and half height. */
const ORIGINAL = 300
const PACED = 600
const HALF = 78

const audioVoiceRepace: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`audio-voice-repace has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const map = await loadTimeMap(host, 'audio/voice-paced.map.json')
  const words = (await loadTimedText(host, 'audio/voice.words.json')).flatMap((c) => c.words ?? [])
  const original = await readWav(host, map.source.path)
  const paced = await readWav(host, map.output.path)
  const { maxPause, keep, tempo } = map.params as {
    maxPause: number
    keep: number[]
    tempo: number
  }
  const mono = `"${FONT.mono}"`

  const scale = (R - L) / map.source.seconds
  const x = (s: number) => L + s * scale
  /** The original time a paced time came from: the map read backwards, held at the recording's end. */
  const sourceTime = (t: number) =>
    Math.min(
      map.source.seconds,
      pacedTime({ ...map, knots: map.knots.map(([a, b]) => [b, a] as [number, number]) }, t),
    )
  /** The removed stretches: knot pairs at one new time. */
  const cuts = map.knots.flatMap((k, i) => {
    const next = map.knots[i + 1]
    return next && next[1] === k[1] ? [[k[0], next[0], k[1]] as const] : []
  })
  const kept = words.flatMap((w, i) => {
    const next = words[i + 1]
    return next && keep.some((k) => k >= w.end && k <= next.start)
      ? [[w.end, next.start] as const]
      : []
  })
  /** The top word: the word sounding in the paced file, held until the next one starts. */
  const top: Word[] = words.map((w, i) => ({
    from: i === 0 ? 0 : pacedTime(map, w.start),
    to:
      i + 1 < words.length
        ? pacedTime(map, (words[i + 1] as (typeof words)[number]).start)
        : duration,
    text: w.text.toUpperCase(),
  }))

  // The waveforms, once: the peak per column, both on the original's scale of seconds.
  const envelope = (s: Signal) =>
    Float32Array.from({ length: Math.ceil(s.length * scale) }, (_, c) => {
      const a = Math.floor((c / scale) * s.rate)
      const b = Math.floor(((c + 1) / scale) * s.rate)
      let m = 0
      for (let i = a; i < b; i++) m = Math.max(m, Math.abs(s.mono[i] ?? 0))
      return m
    })
  const lanes = [
    { y: ORIGINAL, peaks: envelope(original) },
    { y: PACED, peaks: envelope(paced) },
  ]
  const loud = Math.max(...lanes.flatMap((l) => [...l.peaks]))

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

  return {
    async render(t, o) {
      const from = sourceTime(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      // What the tool cut out of the original, and the pause it kept.
      for (const [a, b] of cuts) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)'
        ctx.fillRect(x(a), ORIGINAL - HALF - 6, x(b) - x(a), 2 * HALF + 12)
        label(
          `−${(b - a).toFixed(2)} S`,
          (x(a) + x(b)) / 2,
          ORIGINAL - HALF - 14,
          '#8a8a8a',
          'center',
        )
      }
      for (const [a, b] of kept) {
        ctx.fillStyle = RED
        ctx.fillRect(x(a), ORIGINAL + HALF + 8, x(b) - x(a), 2)
        label('KEPT', (x(a) + x(b)) / 2, ORIGINAL - HALF - 14, RED, 'center')
      }
      // The waveforms, white where the paced file has played.
      for (const lane of lanes) {
        const head = lane.y === PACED ? x(t) : x(from)
        for (let c = 0; c < lane.peaks.length; c++) {
          const a = ((lane.peaks[c] ?? 0) / loud) * HALF
          if (a <= 0) continue
          ctx.fillStyle = L + c <= head ? '#fff' : '#555'
          ctx.fillRect(L + c, lane.y - a, 1, 2 * a)
        }
        ctx.fillStyle = 'rgba(255,255,255,0.25)'
        ctx.fillRect(L, lane.y, R - L, 1)
      }
      // The map: each word's start to where it went, and each cut closing to its join.
      const top0 = ORIGINAL + HALF + 18
      const bottom0 = PACED - HALF - 18
      const line = (a: number, b: number, color: string, w = 1) => {
        ctx.strokeStyle = color
        ctx.lineWidth = w
        ctx.beginPath()
        ctx.moveTo(a, top0)
        ctx.lineTo(b, bottom0)
        ctx.stroke()
      }
      for (const [a, b, at] of cuts) {
        line(x(a), x(at), '#3a3a3a')
        line(x(b), x(at), '#3a3a3a')
      }
      for (const w of words) {
        const p = pacedTime(map, w.start)
        line(x(w.start), x(p), p <= t && t < pacedTime(map, w.end) ? '#fff' : '#6a6a6a')
      }
      // The playheads: the paced time, and the original time it came from.
      ctx.fillStyle = '#fff'
      ctx.fillRect(x(from) - 1, ORIGINAL - HALF - 4, 2, 2 * HALF + 8)
      ctx.fillRect(x(t) - 1, PACED - HALF - 4, 2, 2 * HALF + 8)
      line(x(from), x(t), '#fff', 2)

      label(`ORIGINAL   ${map.source.seconds.toFixed(2)} S`, L, ORIGINAL - HALF - 40)
      label(`PACED   ${map.output.seconds.toFixed(2)} S   TEMPO ${tempo}`, L, PACED + HALF + 34)
      label(`${from.toFixed(2)} S`, x(from) + 8, ORIGINAL + HALF + 2, '#fff')
      label(`${t.toFixed(2)} S`, x(t) + 8, PACED + HALF + 2, '#fff')

      house.words(top, [], t, o.frame)
      house.bigWord({
        text: `−${(map.source.seconds - map.output.seconds).toFixed(2)} S`,
        corner: 'br',
        since: 9,
        frame: o.frame,
      })
      house.note(
        `pauses over ${maxPause} s lose their middle; the one at ${keep.join(', ')} s stays`,
      )
      house.hud(
        t,
        o.frame,
        `ORIGINAL ${from.toFixed(2)} S → PACED ${t.toFixed(2)} S`,
        `MAX PAUSE ${maxPause} S   TEMPO ${tempo}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return `${sourceTime(t).toFixed(2)} s → ${t.toFixed(2)} s`
    },
    inspect(t) {
      return { id: 'map', original: sourceTime(t), paced: t }
    },
    async audio() {
      return [{ src: map.output.path, at: 0 }]
    },
  }
}

export default audioVoiceRepace
