// audio-beat-clock: a synthesised track (preview/make.ts), measured by the item's own
// analyser (tools/analyze-music.ts), drives everything on screen. In the 'all' state the sung word
// lands huge on its stab, the line fills word by word, a 16-step bar counts the clock, and below
// it the song scrolls past the playhead as four band lanes (sub, low, mid, high) on the measured
// beat grid, with the hits and words marked where they fall. Each bar's downbeat flashes the
// frame. The other states give one of those the whole frame: the bands, the beat grid, the lyrics.

import { createHouse, L, R, RED } from '../../previews/src/house.ts'
import {
  bandsOf,
  clockFromAnalysis,
  hitsOf,
  loadAnalysis,
  pulse,
} from '../../previews/src/music/beat.ts'
import { cueAt, loadTimedText, wordAt } from '../../previews/src/music/timed-text.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const SONG = 'audio/beat.wav'
const PLAYHEAD = 300
const PX_PER_S = 250
const LANE_NAMES = ['SUB', 'LOW', 'MID', 'HIGH']

type Timeline = { top: number; height: number; gap: number; lanes: boolean; label: number }
type Layout = {
  /** The part of the frame a downbeat inverts. */
  flash: number
  word?: { baseline: number; maxSize: number }
  line?: { baseline: number; size: number }
  counter?: { baseline: number; size: number }
  steps?: { top: number; height: number }
  timeline: Timeline
}

const LAYOUTS: Record<string, Layout> = {
  all: {
    flash: 494,
    word: { baseline: 392, maxSize: 300 },
    line: { baseline: 470, size: 40 },
    steps: { top: 506, height: 44 },
    timeline: { top: 624, height: 56, gap: 8, lanes: true, label: 15 },
  },
  bands: {
    flash: 104,
    timeline: { top: 196, height: 150, gap: 16, lanes: true, label: 22 },
  },
  grid: {
    flash: 430,
    counter: { baseline: 370, size: 250 },
    steps: { top: 470, height: 120 },
    timeline: { top: 690, height: 160, gap: 0, lanes: false, label: 15 },
  },
  lyrics: {
    flash: 690,
    word: { baseline: 500, maxSize: 400 },
    line: { baseline: 620, size: 58 },
    timeline: { top: 790, height: 60, gap: 0, lanes: false, label: 15 },
  },
}

const audioBeatClock: OpenPreview = async (host, stateId) => {
  const layout = LAYOUTS[stateId]
  if (!layout) throw new Error(`audio-beat-clock has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const analysis = await loadAnalysis(host, SONG, 'audio/beat.analysis.json')
  // The analyser cannot hear the downbeat at 0 s (its onsets start 0.1 s in), so the first one
  // it measures is bar 2's.
  const clock = clockFromAnalysis(analysis, { firstBar: 2 })
  const bands = bandsOf(analysis)
  const strong = analysis.onsets.filter((o) => o.strength >= 450)
  const hits = hitsOf(analysis, { strength: 450 })
  const lyrics = await loadTimedText(host, 'audio/beat.lrc')
  const words = lyrics.flatMap((c) => c.words ?? [])
  const loop = (t: number) => ((t % duration) + duration) % duration
  /** Times repeated a loop either side, for what scrolls past the playhead. */
  const around = (times: readonly number[]) =>
    [-1, 0, 1].flatMap((k) => times.map((x) => x + k * duration))
  const beats = Array.from({ length: 16 }, (_, i) => clock.at(1 + Math.floor(i / 4), i % 4))
  const sans = `"${FONT.sansMedium}"`
  const mono = `"${FONT.mono}"`
  const monoBold = `"${FONT.monoBold}"`

  const state = (t: number) => {
    const p = clock.position(t + 0.0005)
    const bar = ((p.bar - 1 + 400) % 4) + 1
    const word = wordAt(lyrics, t)
    const cue = cueAt(lyrics, t)
    const [sub, low, mid, high] = bands(t)
    return {
      bpm: clock.bpm,
      bar,
      beat: p.beat,
      sixteenth: p.sixteenth,
      step: (p.beat - 1) * 4 + (p.sixteenth - 1),
      word: word?.text ?? '',
      wordAt: word?.start ?? 0,
      line: cue?.words ?? [],
      bands: { sub, low, mid, high },
      downbeat: pulse(t, around(beats.filter((_, i) => i % 4 === 0)), 0.07),
      hit: pulse(t, around(hits), 0.09),
    }
  }
  type S = ReturnType<typeof state>

  const drawWord = (
    t: number,
    s: S,
    o: { baseline: number; maxSize: number },
    ink: string,
    flash: boolean,
  ) => {
    if (!s.word) return
    const since = t - s.wordAt
    const kick = 1 + 0.14 * Math.exp(-since / 0.07)
    ctx.font = `100px ${sans}`
    const size = Math.min(o.maxSize, (100 * (R - L)) / ctx.measureText(s.word).width / 1.14) * kick
    ctx.font = `${size}px ${sans}`
    ctx.textAlign = 'left'
    ctx.fillStyle = since < 0.05 && !flash ? RED : ink
    ctx.fillText(s.word, L - size * 0.04, o.baseline)
  }

  const drawLine = (t: number, s: S, o: { baseline: number; size: number }, flash: boolean) => {
    ctx.font = `${o.size}px ${sans}`
    ctx.textAlign = 'left'
    let x = L
    for (const w of s.line) {
      const sung = w.start <= t
      const current = sung && t < w.end
      ctx.fillStyle = current
        ? flash
          ? '#000'
          : '#fff'
        : sung
          ? flash
            ? '#000'
            : '#8a8a8a'
          : flash
            ? 'rgba(0,0,0,0.35)'
            : '#3a3a3a'
      ctx.fillText(w.text, x, o.baseline)
      const ww = ctx.measureText(w.text).width
      if (current) {
        ctx.fillStyle = flash ? '#000' : RED
        ctx.fillRect(x, o.baseline + o.size * 0.25, ww, Math.max(4, o.size * 0.1))
      }
      x += ww + o.size * 0.3
    }
  }

  const drawCounter = (s: S, o: { baseline: number; size: number }, ink: string) => {
    ctx.font = `${o.size}px ${monoBold}`
    ctx.textAlign = 'left'
    const parts = [String(s.bar), String(s.beat), String(s.sixteenth)]
    let x = L - o.size * 0.04
    for (const [i, part] of parts.entries()) {
      ctx.fillStyle = i === 1 ? (ink === '#000' ? '#000' : RED) : ink
      ctx.fillText(part, x, o.baseline)
      x += ctx.measureText(part).width
      if (i < 2) {
        ctx.fillStyle = ink === '#000' ? '#000' : '#4a4a4a'
        ctx.fillText('.', x, o.baseline)
        x += ctx.measureText('.').width
      }
    }
    ctx.font = `22px ${mono}`
    ctx.fillStyle = ink === '#000' ? '#000' : '#8a8a8a'
    const labels = ['BAR', 'BEAT', '16TH']
    let lx = L
    for (const [i, part] of parts.entries()) {
      ctx.fillText(labels[i] ?? '', lx, o.baseline + 40)
      ctx.font = `${o.size}px ${monoBold}`
      lx += ctx.measureText(`${part}.`).width
      ctx.font = `22px ${mono}`
    }
  }

  const drawSteps = (s: S, o: { top: number; height: number }) => {
    const gap = 6
    const cell = (R - L - 15 * gap) / 16
    for (let i = 0; i < 16; i++) {
      const cx = L + i * (cell + gap)
      const onBeat = i % 4 === 0
      const h = onBeat ? o.height : o.height * 0.55
      const y = o.top + o.height - h
      if (i === s.step) {
        ctx.fillStyle = onBeat ? RED : '#fff'
        ctx.fillRect(cx, y - 6, cell, h + 6)
      } else if (i < s.step) {
        ctx.fillStyle = '#4a4a4a'
        ctx.fillRect(cx, y, cell, h)
      } else {
        ctx.strokeStyle = '#3a3a3a'
        ctx.lineWidth = 2
        ctx.strokeRect(cx + 1, y + 1, cell - 2, h - 2)
      }
    }
  }

  // The song scrolling past the playhead: band lanes (or the onsets alone) on the beat grid, the
  // hits and words marked where they fall.
  const drawTimeline = (t: number, s: S, o: Timeline) => {
    const left = t - PLAYHEAD / PX_PER_S
    const right = t + (R - PLAYHEAD) / PX_PER_S
    const xOf = (time: number) => PLAYHEAD + (time - t) * PX_PER_S
    const top = o.top
    const bottom = o.lanes ? top + 4 * o.height + 3 * o.gap : top + o.height
    ctx.save()
    ctx.beginPath()
    ctx.rect(L, 0, R - L, height)
    ctx.clip()
    for (const [i, b] of around(beats).entries()) {
      if (b < left - 0.1 || b > right) continue
      const down = i % 4 === 0
      ctx.fillStyle = down ? '#6a6a6a' : '#262626'
      ctx.fillRect(
        Math.round(xOf(b)),
        top - (down ? 22 : 0),
        down ? 2 : 1,
        bottom - top + (down ? 22 : 0),
      )
      if (down) {
        ctx.font = `15px ${mono}`
        ctx.textAlign = 'left'
        ctx.fillStyle = '#6a6a6a'
        ctx.fillText(String((Math.floor(i / 4) % 4) + 1), xOf(b) + 6, top - 8)
      }
    }
    if (o.lanes)
      for (let lane = 0; lane < 4; lane++) {
        const y0 = top + lane * (o.height + o.gap)
        const mid = y0 + o.height / 2
        const step = o.height > 100 ? 4 : 3
        for (let px = L; px < R; px += step) {
          const time = t + (px - PLAYHEAD) / PX_PER_S
          const v = bands(loop(time))[lane] ?? 0
          const h = Math.max(1, v ** 1.6 * o.height)
          ctx.fillStyle = px <= PLAYHEAD ? '#fff' : '#555'
          ctx.fillRect(px, mid - h / 2, step - 1, h)
        }
        ctx.font = `${o.label}px ${mono}`
        ctx.textAlign = 'left'
        const label = `${LANE_NAMES[lane]} ${(bands(t)[lane] ?? 0).toFixed(2)}`
        ctx.fillStyle = '#000'
        ctx.fillRect(L, y0, ctx.measureText(label).width + 8, o.label * 1.35)
        ctx.fillStyle = '#9a9a9a'
        ctx.fillText(label, L + 2, y0 + o.label)
      }
    // No lanes: every onset as a bar as tall as it is strong.
    else
      for (const k of [-1, 0, 1])
        for (const on of analysis.onsets) {
          const at = on.t + k * duration
          if (at < left - 0.1 || at > right) continue
          const h = Math.min(1, on.strength / 1200) * o.height
          ctx.fillStyle = at <= t ? '#fff' : '#555'
          ctx.fillRect(xOf(at) - 2, bottom - h, 4, h)
        }
    for (const k of [-1, 0, 1])
      for (const on of strong) {
        const at = on.t + k * duration
        if (at < left - 0.1 || at > right) continue
        const hx = xOf(at)
        ctx.fillStyle = at <= t ? RED : '#7a2a1c'
        ctx.beginPath()
        ctx.moveTo(hx - 6, bottom + 4)
        ctx.lineTo(hx + 6, bottom + 4)
        ctx.lineTo(hx, bottom - 6)
        ctx.fill()
      }
    for (const w of [-1, 0, 1].flatMap((k) =>
      words.map((x) => ({ ...x, start: x.start + k * duration })),
    )) {
      if (w.start < left - 1 || w.start > right) continue
      const wx = xOf(w.start)
      ctx.font = `17px ${mono}`
      ctx.textAlign = 'left'
      ctx.fillStyle = w.start <= t ? '#fff' : '#6a6a6a'
      ctx.fillText(w.text, wx + 5, top - 30)
      ctx.fillRect(wx, top - 46, 2, 20)
    }
    ctx.restore()
    // The playhead: now.
    ctx.fillStyle = s.hit > 0.4 ? RED : '#fff'
    ctx.fillRect(PLAYHEAD - 1, top - 50, 3, bottom - top + 56)
  }

  return {
    async render(t) {
      const s = state(t)
      const flash = s.downbeat > 0.5
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      if (flash) {
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, width, layout.flash)
      }
      // The house's index number behind everything, and its labels top right.
      house.index()
      house.labels()
      const ink = flash ? '#000' : '#fff'
      // Header: the measured tempo, and where t is on the grid.
      ctx.textBaseline = 'alphabetic'
      ctx.font = `22px ${mono}`
      ctx.fillStyle = flash ? '#000' : '#8a8a8a'
      ctx.textAlign = 'left'
      ctx.fillText(`TEMPO ${s.bpm.toFixed(2)} BPM`, L, 70)
      ctx.textAlign = 'right'
      ctx.fillText(`BAR ${s.bar}   BEAT ${s.beat}   16TH ${s.sixteenth}`, R, 70)
      ctx.fillStyle = ink
      ctx.fillRect(L, 88, R - L, 2)
      if (layout.word) drawWord(t, s, layout.word, ink, flash)
      if (layout.line) drawLine(t, s, layout.line, flash)
      if (layout.counter) drawCounter(s, layout.counter, ink)
      if (layout.steps) drawSteps(s, layout.steps)
      drawTimeline(t, s, layout.timeline)
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${Math.round(s.bpm)} BPM  ${s.bar}.${s.beat}.${s.sixteenth}`
    },
    inspect(t) {
      const s = state(t)
      return {
        id: 'clock',
        bpm: s.bpm,
        bar: s.bar,
        beat: s.beat,
        sixteenth: s.sixteenth,
        bands: s.bands,
        downbeat: s.downbeat,
        hit: s.hit,
        word: s.word,
      }
    },
    async audio() {
      return [{ src: SONG, at: 0 }]
    },
  }
}

export default audioBeatClock
