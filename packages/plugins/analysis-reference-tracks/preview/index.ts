// analysis-reference-tracks: a card's x, as if measured from a reference at 8 fps, from 0.75 s to
// 4 s of its source: still, then a damped spring across the frame, then still. The samples go
// through the plugin's own writer and come back through its reader, as a film reads them. Above,
// the track against source time: the samples as dots, hold as steps, linear as lines, and the
// playhead. Below, two cards placed by `at` at the same time, one with hold and one with linear.
// Before the first sample both read null and no card shows; after the last both hold it.

import type { Host } from '@shaderera/core'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { at, loadTracks, type Sample, track } from '../../previews/src/reference/tracks.ts'
import { fileSource, tracksJson } from '../../previews/tools/reference-tracks.ts'

/** The reference's frame, in its pixels, and when and how often it was sampled. */
const FRAME = { width: 1280, height: 720 }
const FPS = 8
const FIRST = 0.75
const LAST = 4
/** The spring the card moved by in the reference, from MOVE seconds. */
const MOVE = 1.25
const FROM = 160
const TO = 1000
const spring = (s: number) => {
  const u = Math.max(0, s - MOVE)
  return TO - (TO - FROM) * Math.exp(-3.2 * u) * Math.cos(7.5 * u)
}
const GRAPH = { top: 200, bottom: 480 }
const LANES = { hold: 610, linear: 730 }
const CARD = 64

const preview: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`analysis-reference-tracks has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The measurement, written once by the writer an analyser uses. The reference clip is a
  // stand-in: these bytes only give the source a hash to check.
  const clip = new TextEncoder().encode('reference clip: a card that springs across')
  const samples: Sample[] = []
  for (let k = 0; FIRST + k / FPS <= LAST + 1e-9; k++) {
    const s = FIRST + k / FPS
    samples.push([s, spring(s)])
  }
  const json = tracksJson({
    format: 'shaderera.analysis/1',
    kind: 'reference-tracks',
    source: await fileSource('references/card.mp4', clip),
    tool: { script: 'preview/index.ts' },
    params: { fps: FPS },
    frame: { ...FRAME, pixelRatio: 1 },
    tracks: [{ element: 'card', channel: 'x', unit: 'source-px', samples }],
    declared: [],
    limits: [],
  })
  const files = new Map([
    ['references/card.mp4', clip],
    ['references/card.tracks.json', new TextEncoder().encode(json)],
  ])
  const reader = {
    ...host,
    io: {
      ...host.io,
      read: async (path: string) => {
        const b = files.get(path)
        if (!b) throw new Error(`No file ${path}`)
        return b
      },
    },
  } as Host
  const tracks = await loadTracks(reader, 'references/card.tracks.json')
  const x = track(tracks, 'card', 'x')

  // The film's own mapping: here source time is render time.
  const sourceOf = (t: number) => t
  const tx = (s: number) => L + (s / duration) * (R - L)
  const lo = 0
  const hi = FRAME.width
  const ty = (v: number) => GRAPH.bottom - ((v - lo) / (hi - lo)) * (GRAPH.bottom - GRAPH.top)
  const lx = (v: number) => L + CARD / 2 + (v / FRAME.width) * (R - L - CARD)
  const fmt = (v: number | null) => (v === null ? 'null' : v.toFixed(1))

  const top: Word[] = [{ from: 0, to: 99, text: 'TRACKS' }]
  const bottom: Word[] = [
    { from: 0, to: FIRST, text: 'BEFORE' },
    { from: FIRST, to: LAST, text: 'BETWEEN' },
    { from: LAST, to: 99, text: 'AFTER' },
  ]
  const notes = (s: number) =>
    s < FIRST
      ? 'before the first sample: null'
      : s < LAST
        ? 'between samples, the film says how to fill'
        : 'after the last sample: the last value, held'

  const lane = (y: number, name: string, v: number | null, now: boolean) => {
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.fillRect(L, y, R - L, 1)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(`${name}  ${fmt(v)}`, L, y - CARD / 2 - 14)
    if (v === null) return
    const cx = lx(v)
    ctx.fillStyle = now ? RED : '#4a4a4a'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.fillRect(cx - CARD / 2, y - CARD / 2, CARD, CARD)
    ctx.strokeRect(cx - CARD / 2, y - CARD / 2, CARD, CARD)
  }

  return {
    async render(t, o) {
      const s = sourceOf(t)
      const held = at(x, s, { between: 'hold' })
      const line = at(x, s, { between: 'linear' })
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      // The track: frame edges, hold steps, linear lines, the samples, the playhead.
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(L, ty(0), R - L, 1)
      ctx.fillRect(L, ty(FRAME.width), R - L, 1)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      x.samples.forEach(([time, v], i) => {
        const next = x.samples[i + 1]
        const end = next ? next[0] : duration
        if (v === null) return
        ctx.moveTo(tx(time), ty(v))
        ctx.lineTo(tx(end), ty(v))
        if (next && next[1] !== null) ctx.lineTo(tx(end), ty(next[1]))
      })
      ctx.stroke()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.beginPath()
      x.samples.forEach(([time, v], i) => {
        if (v === null) return
        if (i === 0) ctx.moveTo(tx(time), ty(v))
        else ctx.lineTo(tx(time), ty(v))
      })
      ctx.stroke()
      for (const [time, v] of x.samples) {
        if (v === null) continue
        ctx.fillStyle = time <= s ? '#fff' : 'rgba(255,255,255,0.45)'
        ctx.beginPath()
        ctx.arc(tx(time), ty(v), 3.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = RED
      ctx.fillRect(tx(s) - 1, GRAPH.top - 20, 2, GRAPH.bottom - GRAPH.top + 40)
      for (const v of [held, line]) {
        if (v === null) continue
        ctx.beginPath()
        ctx.arc(tx(s), ty(v), 6, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.font = `13px ${mono}`
      ctx.textAlign = 'left'
      ctx.fillStyle = '#8a8a8a'
      ctx.fillText('CARD X  SOURCE-PX', L, GRAPH.top - 30)
      ctx.textAlign = 'right'
      ctx.fillText('SOURCE TIME', R, GRAPH.bottom + 38)

      lane(LANES.hold, "HOLD   at(x, t, { between: 'hold' })", held, true)
      lane(LANES.linear, "LINEAR at(x, t, { between: 'linear' })", line, false)

      house.words(top, bottom, t, o.frame)
      house.note(notes(s))
      house.hud(
        t,
        o.frame,
        `HOLD ${fmt(held)}   LINEAR ${fmt(line)}`,
        `${x.samples.length} SAMPLES   ${FPS} FPS   ${FIRST}–${LAST} S`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return fmt(at(x, sourceOf(t), { between: 'linear' }))
    },
    inspect(t) {
      const s = sourceOf(t)
      return {
        id: 'reference-tracks',
        source: s,
        hold: at(x, s, { between: 'hold' }),
        linear: at(x, s, { between: 'linear' }),
        samples: x.samples.length,
      }
    },
  }
}

export default preview
