// audio-hall-ending: a phrase made in code (preview/make.ts) stops dead at 2.3 s, and the item's
// tools/hall-ending.ts rings its last chord out in a hall to digital silence. The picture is the
// file the tool wrote, flat: its waveform (the peak per column, on a dB scale so the tail reads),
// red markers where the phrase stops and where silence begins, the tool's send as a grey tick, and
// a playhead moving through it with the sound.

import { AREA, createHouse, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { levelAt, readWav } from './signal.ts'

const SONG = 'audio/hall-end.wav'
const L = AREA.left
const R = AREA.right
/** The waveform's centre line and half height. */
const MID = 450
const HALF = 200
/** The quietest level drawn, in dBFS. */
const FLOOR = -66

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
  const mono = `"${FONT.mono}"`

  // The waveform, once: the peak per column in dB, 0 to 1 above the floor.
  const columns = R - L
  const envelope = Float32Array.from({ length: columns }, (_, x) => {
    const a = Math.floor((x / columns) * duration * wet.rate)
    const b = Math.floor(((x + 1) / columns) * duration * wet.rate)
    let m = 0
    for (let i = a; i < b; i++) m = Math.max(m, Math.abs(wet.mono[i] ?? 0))
    return m === 0 ? 0 : Math.max(0, (20 * Math.log10(m) - FLOOR) / -FLOOR)
  })
  const xOf = (time: number) => L + (time / duration) * columns

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

  const drawScale = () => {
    ctx.font = `12px ${mono}`
    ctx.textAlign = 'left'
    // Level lines every 20 dB, both sides of the centre.
    for (let db = 0; db > FLOOR; db -= 20) {
      const a = ((db - FLOOR) / -FLOOR) * HALF
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(L, MID - a, columns, 1)
      ctx.fillRect(L, MID + a, columns, 1)
      ctx.fillStyle = '#6a6a6a'
      ctx.fillText(`${db} DB`, L + 4, MID - a - 5)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(L, MID, columns, 1)
    // Seconds along the bottom.
    ctx.textAlign = 'center'
    for (let s = 0; s <= duration; s++) {
      const x = Math.round(xOf(s))
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(Math.min(x, R - 1), MID + HALF + 12, 1, 8)
      ctx.fillStyle = '#8a8a8a'
      ctx.textAlign = s === 0 ? 'left' : s === duration ? 'right' : 'center'
      ctx.fillText(`${s} S`, x, MID + HALF + 36)
    }
  }

  const drawWave = (s: S) => {
    const head = xOf(s.t)
    for (let c = 0; c < columns; c++) {
      const a = (envelope[c] ?? 0) * HALF
      if (a <= 0) continue
      ctx.fillStyle = L + c <= head ? '#fff' : '#555'
      ctx.fillRect(L + c, MID - a, 1, 2 * a)
    }
    // The silence the file ends on: a flat line.
    ctx.fillStyle = s.t >= ending.gone ? '#fff' : '#555'
    ctx.fillRect(xOf(ending.gone), MID - 1, R - xOf(ending.gone), 2)
  }

  const drawMarkers = () => {
    const top = MID - HALF - 30
    const bottom = MID + HALF + 4
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    // The tool's send: where the hall opens.
    const sx = Math.round(xOf(ending.send))
    ctx.fillStyle = '#8a8a8a'
    ctx.fillRect(sx, top + 14, 1, bottom - top - 14)
    ctx.fillText(`--send ${ending.send}`, sx + 6, top + 26)
    // Where the phrase stops dead, and where the file is digital silence.
    for (const [time, label] of [
      [ending.end, `STOPS ${ending.end.toFixed(2)} S`],
      [ending.gone, `SILENT ${ending.gone.toFixed(2)} S`],
    ] as const) {
      const x = Math.round(xOf(time))
      ctx.fillStyle = RED
      ctx.fillRect(x - 1, top - 12, 2, bottom - top + 12)
      ctx.fillText(label, x + 6, top - 2)
    }
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
    tail: `ringing in a ${ending.rt} s hall, down to silence`,
    silence: 'digital silence, and the picture holds on',
  } as const

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      drawScale()
      drawWave(s)
      drawMarkers()
      // The playhead.
      const head = Math.round(xOf(t))
      ctx.fillStyle = '#fff'
      ctx.fillRect(head - 1, MID - HALF - 8, 2, 2 * HALF + 16)
      house.bigWord({
        text: WORD[s.phase],
        corner: 'tl',
        since: s.since,
        until: s.until,
        frame: o.frame,
        maxWidth: 760,
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
