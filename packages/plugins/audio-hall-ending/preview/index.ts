// audio-hall-ending: a phrase made in code (preview/make.ts) stops dead at 2.3 s,
// and the item's tools/hall-ending.ts rings its last chord out in a hall to digital silence. What
// plays is drawn as a luminous point field: the spectrum, row by row, sliding away from the
// playhead (jagged while the phrase plays, a red marker row where it stops dead, soft peach ridges
// as the hall dies, highs first, then flat), with the camera drifting through it all the way into
// the silence. Below it, the whole ending with the tool's send, dry end, fade and silence.

import { AREA, createHouse, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { levelAt, readWav, spectrogram } from './signal.ts'

const SONG = 'audio/hall-end.wav'
const L = AREA.left
const R = AREA.right
const PER_SECOND = 60
const BANDS = 84
/** Seconds of history in the field, and a row every this many seconds. */
const SPAN = 1.6
const DT = 1 / 30
const FLOOR = -96
const TAU = Math.PI * 2

type Ending = {
  send: number
  end: number
  rt: number
  wet: number
  quiet: number
  gone: number
  duration: number
}

const audioHallEnding: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`audio-hall-ending has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const ending = JSON.parse(
    new TextDecoder().decode(await host.io.read('audio/hall.json')),
  ) as Ending
  const wet = await readWav(host, SONG)
  const spec = spectrogram(wet, { perSecond: PER_SECOND, bands: BANDS, low: 45, high: 16000 })
  const loop = (t: number) => ((t % duration) + duration) % duration
  const mono = `"${FONT.mono}"`

  // The overview's envelope, once: the peak per column in dB.
  const OV = { top: 704, height: 46 }
  const columns = R - L
  const envelope = Float32Array.from({ length: columns }, (_, x) => {
    const a = Math.floor((x / columns) * duration * wet.rate)
    const b = Math.floor(((x + 1) / columns) * duration * wet.rate)
    let m = 0
    for (let i = a; i < b; i++) m = Math.max(m, Math.abs(wet.mono[i] ?? 0))
    return m === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(m)
  })

  const state = (t: number) => {
    const lv = levelAt(wet, t + 1 / 60, 1 / 20)
    const phase: 'phrase' | 'stop' | 'tail' | 'silence' =
      t < ending.end
        ? 'phrase'
        : lv.silent || t >= ending.gone
          ? 'silence'
          : t < ending.end + 0.8
            ? 'stop'
            : 'tail'
    const start = { phrase: 0, stop: ending.end, tail: ending.end + 0.8, silence: ending.gone }
    const end = { phrase: ending.end, stop: ending.end + 0.8, tail: ending.gone, silence: duration }
    return {
      t,
      rms: lv.rms,
      silent: lv.silent,
      phase,
      since: t - start[phase],
      until: end[phase] - t,
    }
  }
  type S = ReturnType<typeof state>

  /** A band in 0–1 above the floor at `time` (wrapped to the loop). */
  const band = (time: number, b: number) => {
    const r = Math.min(spec.rows - 1, Math.max(0, Math.round(loop(time) * PER_SECOND)))
    const v = spec.db[r * BANDS + b] ?? FLOOR
    return Math.max(0, (v - FLOOR) / -FLOOR)
  }

  // The field: rows at fixed song times, sliding back as t moves on, through a drifting camera.
  const drawField = (s: S) => {
    const ph = (s.t / duration) * TAU
    const horizon = 250 + 50 * Math.sin(ph * 2 + 1)
    const front = 650
    const yaw = 230 * Math.sin(ph + 0.6)
    const lift = 300 + 30 * Math.sin(ph * 2)
    ctx.globalCompositeOperation = 'lighter'
    const newest = Math.floor(s.t / DT) * DT
    for (let k = Math.ceil(SPAN / DT); k >= 0; k--) {
      const time = newest - k * DT
      const z = (s.t - time) / SPAN
      if (z > 1 || z < 0) continue
      const scale = 1 / (1 + z * 2.6)
      const base = horizon + (front - horizon) * scale
      const half = ((R - L) / 2 + 60) * scale
      const cx = width / 2 + yaw * z
      const wrapped = loop(time)
      const stopRow = Math.abs(wrapped - ending.end) < DT / 2 + 1e-6
      const silent = wrapped >= ending.gone
      const tail = wrapped >= ending.end && !silent
      const fade = (1 - z) ** 1.3
      // Phrase rows white, tail rows peach, silent rows a cold grey; points over a faint line.
      const [r, g, b] = stopRow
        ? [255, 59, 31]
        : tail
          ? [255, 196, 160]
          : silent
            ? [150, 165, 190]
            : [255, 255, 255]
      ctx.beginPath()
      const pts: number[] = []
      for (let i = 0; i < BANDS; i++) {
        const v = silent ? 0 : band(time, i) ** 1.7
        const x = cx - half + (2 * half * i) / (BANDS - 1)
        const y = base - v * lift * scale
        pts.push(x, y)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = `rgba(${r},${g},${b},${(stopRow ? 0.9 : 0.16) * fade})`
      ctx.lineWidth = stopRow ? 2.5 : 1
      ctx.stroke()
      const dot = 1.2 + 2.2 * scale
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i] as number
        const y = pts[i + 1] as number
        // Silent rows stay flat; ripples of light run back through them, and across.
        const scan = silent
          ? Math.max(
              0,
              Math.cos(z * TAU * 2.5 - s.t * TAU * 1.5 + Math.sin((i / BANDS) * 3) * 2),
            ) ** 6
          : 0
        ctx.fillStyle = `rgba(${r},${g},${b},${(silent ? 0.22 + 0.78 * scan : 0.85) * fade})`
        const d = dot * (1 + scan)
        ctx.fillRect(x - d / 2, y - d / 2, d, d)
        // Between the bands, a dimmer point, so the rows read as a cloud.
        if (i + 2 < pts.length) {
          const mx = (x + (pts[i + 2] as number)) / 2
          const my = (y + (pts[i + 3] as number)) / 2
          ctx.fillRect(mx - 0.6, my - 0.6, 1.2, 1.2)
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  const drawOverview = (s: S) => {
    const { top, height: h } = OV
    const x = (time: number) => L + (time / duration) * (R - L)
    const mid = top + h / 2
    const amp = (v: number) => Math.max(0, (v - FLOOR) / -FLOOR) * (h / 2)
    for (let c = 0; c < columns; c += 2) {
      const a = amp(envelope[c] ?? FLOOR)
      if (a <= 0) continue
      const played = L + c <= x(s.t)
      const tail = ((c + 0.5) / columns) * duration >= ending.end
      ctx.fillStyle = played
        ? tail
          ? 'rgba(255,196,160,0.85)'
          : 'rgba(255,255,255,0.85)'
        : 'rgba(255,255,255,0.2)'
      ctx.fillRect(L + c, mid - a, 1, 2 * a)
    }
    // The silence the film holds: a thin line; the tool's numbers as ticks.
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillRect(x(ending.gone), mid, R - x(ending.gone), 1)
    ctx.font = `12px ${mono}`
    ctx.textAlign = 'left'
    for (const [time, label] of [
      [ending.send, 'SEND'],
      [ending.end, 'DRY END'],
      [ending.quiet, 'FADE'],
      [ending.gone, 'SILENT'],
    ] as const) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillRect(Math.round(x(time)), top - 14, 1, h + 14)
      ctx.fillText(label, x(time) + 5, top - 4)
    }
    // The playhead: a red marker.
    ctx.fillStyle = RED
    ctx.fillRect(Math.round(x(s.t)) - 1, top - 18, 2, h + 22)
  }

  const WORD = {
    phrase: 'THE PHRASE',
    stop: 'STOPS DEAD',
    tail: 'RINGING OUT',
    silence: 'SILENCE',
  } as const
  const NOTE = {
    phrase: `a phrase that stops dead at ${ending.end.toFixed(2)} s`,
    stop: `its last chord, sent into the hall at ${ending.send} s`,
    tail: `ringing in a ${ending.rt} s hall, the highs first`,
    silence: 'digital silence, and the picture holds on',
  } as const

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      drawField(s)
      drawOverview(s)
      // The phase, top left; the level, bottom right.
      house.bigWord({
        text: WORD[s.phase],
        corner: 'tl',
        since: s.since,
        until: s.until,
        frame: o.frame,
        maxWidth: 760,
        color: s.phase === 'stop' ? RED : '#fff',
      })
      house.bigWord({
        text: s.silent ? '−∞ DB' : `−${Math.abs(s.rms).toFixed(1)} DB`,
        corner: 'br',
        since: s.phase === 'phrase' ? s.since : 9,
        until: s.phase === 'silence' ? s.until : 9,
        frame: o.frame,
      })
      house.note(NOTE[s.phase])
      house.hud(
        t,
        o.frame,
        `${s.silent ? '−∞' : s.rms.toFixed(1)} DBFS   SILENT FROM ${ending.gone.toFixed(2)} S`,
        `RT60 ${ending.rt.toFixed(1)} S   WET +${ending.wet} DB`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return s.phase === 'phrase'
        ? 'phrase'
        : s.phase === 'silence'
          ? `silence ${s.since.toFixed(1)} s`
          : `ringing out ${(t - ending.end).toFixed(1)} s`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'ending', phase: s.phase, rms: s.silent ? null : s.rms, silent: s.silent }
    },
    async audio() {
      return [{ src: SONG, at: 0 }]
    },
  }
}

export default audioHallEnding
