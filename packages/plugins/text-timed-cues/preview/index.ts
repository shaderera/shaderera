// text-timed-cues: three small timed-text files, an LRC with word times, an SRT and a WebVTT,
// parsed by the plugin and laid out as three lanes of cues that scroll past a fixed playhead.
// Above them, set plainly, what the plugin answers at t: wordAt (the word being sung) and cueAt
// (its line, the sung words white). Each lane says what cueAt gives for its own file. The cue
// times sit inside the 6 s loop and the lanes repeat a loop either side, so it is seamless.

import { createHouse, L, R, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { type Cue, cueAt, parseTimedText, wordAt } from '../../previews/src/type/timed-text.ts'

const LRC = `[ti:Timed cues preview]
[00:00.00]<00:00.00>every <00:00.40>line <00:00.80>has <00:01.10>a <00:01.30>start <00:01.80>
[00:02.00]<00:02.00>every <00:02.40>word <00:02.80>has <00:03.10>its <00:03.40>own <00:03.80>
[00:04.00]<00:04.00>ask <00:04.40>for <00:04.80>both <00:05.10>at <00:05.40>t <00:05.80>
[00:06.00]
`

const SRT = `1
00:00:00,300 --> 00:00:01,700
Subtitles from SRT

2
00:00:02,200 --> 00:00:03,600
<i>with ends</i> of their own

3
00:00:04,000 --> 00:00:05,500
and gaps between
`

const VTT = `WEBVTT

00:00.800 --> 00:02.400
WebVTT cues

00:03.000 --> 00:04.600 align:start
read the same way

00:05.000 --> 00:05.900
times only
`

const PLAYHEAD = L + 300
const PX_PER_S = 190
const LANE = { top: 520, height: 64, gap: 52 }

const preview: OpenPreview = async (host, state) => {
  if (state !== 'default') throw new Error(`text-timed-cues has no state "${state}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const lanes = [
    { label: 'LRC', cues: parseTimedText('cues.lrc', LRC) },
    { label: 'SRT', cues: parseTimedText('cues.srt', SRT) },
    { label: 'VTT', cues: parseTimedText('cues.vtt', VTT) },
  ]
  const lyrics = lanes[0]?.cues ?? []
  const loop = (t: number) => ((t % duration) + duration) % duration
  const sans = `"${FONT.sans}"`
  const sansMedium = `"${FONT.sansMedium}"`
  const mono = `"${FONT.mono}"`
  const words = lyrics.reduce((n, c) => n + (c.words?.length ?? 0), 0)
  const cues = lanes.reduce((n, l) => n + l.cues.filter((c) => c.text).length, 0)
  const oneLine = (c: Cue) => c.text.replace(/\n/g, ' ')

  const label = (text: string, x: number, y: number, color = '#8a8a8a') => {
    ctx.font = `16px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
  }

  return {
    async render(t, o) {
      const now = loop(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.textBaseline = 'alphabetic'
      house.index()

      // What the plugin answers at t: the word, then its line.
      const word = wordAt(lyrics, now)
      const line = cueAt(lyrics, now)
      label('wordAt(cues, t)', L, 176)
      if (word) {
        ctx.font = `100px ${sansMedium}`
        const size = Math.min(160, (100 * (R - L)) / ctx.measureText(word.text).width)
        ctx.font = `${size}px ${sansMedium}`
        ctx.fillStyle = '#fff'
        ctx.fillText(word.text, L - size * 0.04, 318)
      }
      label('cueAt(cues, t)', L, 380)
      ctx.font = `46px ${sans}`
      let x = L
      for (const w of line?.words ?? []) {
        const sung = w.start <= now
        const ww = ctx.measureText(w.text).width
        ctx.fillStyle = sung ? '#fff' : '#4a4a4a'
        ctx.fillText(w.text, x, 438)
        if (w === word) {
          ctx.fillStyle = RED
          ctx.fillRect(x, 452, ww, 4)
        }
        x += ww + 14
      }

      // The three files as lanes of cues, scrolling past the playhead.
      ctx.save()
      ctx.beginPath()
      ctx.rect(L, 0, R - L, height)
      ctx.clip()
      for (const [i, lane] of lanes.entries()) {
        const top = LANE.top + i * (LANE.height + LANE.gap)
        const active = cueAt(lane.cues, now)
        label(lane.label, L, top - 14, '#fff')
        label(active ? `→ "${oneLine(active)}"` : '→ undefined', L + 56, top - 14)
        for (const k of [-1, 0, 1])
          for (const c of lane.cues) {
            if (!c.text) continue
            const start = c.start + k * duration
            const end = Math.min(c.end, duration) + k * duration
            const x0 = PLAYHEAD + (start - t) * PX_PER_S
            const x1 = PLAYHEAD + (end - t) * PX_PER_S
            if (x1 < L || x0 > R) continue
            const on = k === 0 && c === active
            if (on) {
              ctx.fillStyle = '#fff'
              ctx.fillRect(x0, top, x1 - x0, LANE.height)
            } else {
              ctx.strokeStyle = '#4a4a4a'
              ctx.lineWidth = 2
              ctx.strokeRect(x0 + 1, top + 1, x1 - x0 - 2, LANE.height - 2)
            }
            ctx.save()
            ctx.beginPath()
            ctx.rect(x0, top, x1 - x0, LANE.height)
            ctx.clip()
            ctx.fillStyle = on ? '#000' : '#9a9a9a'
            if (c.words)
              // LRC's word times: a tick and the word where each starts.
              for (const w of c.words) {
                const wx = PLAYHEAD + (w.start + k * duration - t) * PX_PER_S
                ctx.fillRect(wx, top + 12, 2, LANE.height - 24)
                ctx.font = `20px ${sans}`
                ctx.fillText(w.text, wx + 8, top + 40)
              }
            else {
              ctx.font = `20px ${sans}`
              ctx.fillText(oneLine(c), x0 + 10, top + 40)
            }
            ctx.restore()
          }
      }
      ctx.restore()
      // The playhead: t, across each lane.
      ctx.fillStyle = RED
      for (let i = 0; i < lanes.length; i++)
        ctx.fillRect(PLAYHEAD - 1, LANE.top + i * (LANE.height + LANE.gap) - 6, 3, LANE.height + 12)

      house.hud(t, o.frame, `LRC SRT VTT   ${cues} CUES   ${words} WORDS`)
      return [{ color: canvas }]
    },
    status(t) {
      const w = wordAt(lyrics, loop(t))
      return w ? `WORD ${w.text.toUpperCase()}` : ''
    },
    inspect(t) {
      const now = loop(t)
      return {
        id: 'cues',
        word: wordAt(lyrics, now)?.text ?? null,
        ...Object.fromEntries(lanes.map((l) => [l.label, cueAt(l.cues, now)?.text ?? null])),
      }
    },
  }
}

export default preview
