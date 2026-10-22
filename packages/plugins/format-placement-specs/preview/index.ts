// format-placement-specs: the preset's delivery/placements.json, read as a film's requirements.json
// would take it, one placement a second with a hard cut between them. Its name scrambles in at the
// top left and its defining number at the bottom right; thin instruments state its numbers (the
// bitrate window on a log scale, the loudness target band, the allowed frame and sample rates), and
// a flat grey card stands in for the picture inside the placement's aspect frame, its safe zone
// drawn in thin lines with red corners. A playhead runs along the list of placements.

import { AREA, createHouse, RED, scramble } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

type Placement = {
  name: string
  source: string
  containers?: string[]
  videoCodecs?: string[]
  aspect?: string
  maxDuration?: number
  durations?: number[]
  maxBytes?: number
  editList?: boolean
  safeArea?: { top: number; right: number; bottom: number; left: number }
  minBitrate?: number
  maxBitrate?: number
  minWidth?: number
  minHeight?: number
  fps?: number[]
  audio?: 'required' | 'none'
  audioCodecs?: string[]
  sampleRates?: number[]
  minChannels?: number
  loudness?: { integrated: number; tolerance: number; maxTruePeak: number }
  transfer?: string[]
  bitDepth?: number[]
  hdrMetadata?: 'required'
}

const L = AREA.left
const R = AREA.right
const STEP = 1
/** How long a value scrambles in after a cut. */
const DECODE = 0.3
const FPS_TICKS = [23.976, 24, 25, 29.97, 30, 50, 60]
const RATES = [44100, 48000, 96000]
const BITRATE = { lo: 1e6, hi: 6e7 }
const LUFS = { lo: -32, hi: -14 }
/** Short names for the big word; an entry not listed shows its id. */
const SHORT: Record<string, string> = {
  'meta-reels-ads': 'META REELS',
  'youtube-1080p30-sdr': 'YOUTUBE',
  'youtube-hdr': 'YOUTUBE HDR',
  'amazon-streaming-tv': 'AMAZON CTV',
  'eu-broadcast-r128': 'EU R128',
  'us-broadcast-a85': 'US A/85',
  'dooh-obb-2026': 'DOOH',
}

const mbs = (bps: number) => `${(bps / 1e6).toFixed(0)} MB/S`
const aspectOf = (p: Placement) =>
  p.aspect ? Number(p.aspect.split(':')[0]) / Number(p.aspect.split(':')[1]) : 0
const domainOf = (src: string) => /https?:\/\/(?:www\.)?([^/]+)/.exec(src)?.[1] ?? 'the standard'
const readDate = (src: string) => /read (\d{4}-\d{2}-\d{2})/.exec(src)?.[1] ?? ''
/** The number that defines a placement, for the big word at the bottom right. */
const defining = (p: Placement) =>
  p.audio === 'none'
    ? 'SILENT'
    : p.loudness
      ? `${p.loudness.integrated} LUFS`.replace('-', '−')
      : p.bitDepth
        ? `${p.bitDepth.join('/')} BIT HDR`
        : p.minBitrate
          ? `≥ ${mbs(p.minBitrate)}`
          : p.maxBitrate
            ? `≤ ${mbs(p.maxBitrate)}`
            : (p.aspect ?? 'ANY')

const formatPlacementSpecs: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`format-placement-specs has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const all = JSON.parse(
    new TextDecoder().decode(await host.io.read('delivery/placements.json')),
  ) as Record<string, Placement>
  const ids = Object.keys(all)
  const count = ids.length
  const mono = `"${FONT.mono}"`
  const monoBold = `"${FONT.monoBold}"`
  const loop = (t: number) => ((t % duration) + duration) % duration
  const at = (i: number) => {
    const id = ids[((i % count) + count) % count] as string
    return { id, p: all[id] as Placement }
  }

  const state = (time: number, frame: number) => {
    const t = loop(time) * ((count * STEP) / duration)
    const n = Math.floor(t / STEP)
    const since = t - n * STEP
    return { t: loop(time), n: n % count, cur: at(n), since, frame }
  }
  type S = ReturnType<typeof state>

  const COL = { x0: L, x1: 500, top: 262, step: 96 }
  const rowY = (i: number) => COL.top + i * COL.step

  const label = (s: S, row: number, text: string, value: string, y: number) => {
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(text, COL.x0, y - 40)
    ctx.font = `22px ${monoBold}`
    ctx.textAlign = 'right'
    ctx.fillStyle = '#fff'
    const k = Math.min(1, Math.max(0, (s.since - row * 0.04) / DECODE))
    ctx.fillText(scramble(value, k, s.frame, row * 9), COL.x1, y - 36)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(COL.x0, y - 62, COL.x1 - COL.x0, 1)
  }
  const chip = (text: string, x: number, y: number, on: number, accent = false) => {
    ctx.font = `13px ${mono}`
    const w = ctx.measureText(text).width + 12
    ctx.strokeStyle = accent ? RED : on > 0.5 ? '#fff' : 'rgba(255,255,255,0.22)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y - 15.5, w - 1, 21)
    ctx.fillStyle = accent ? RED : on > 0.5 ? '#fff' : 'rgba(255,255,255,0.3)'
    ctx.textAlign = 'left'
    ctx.fillText(text, x + 6, y)
    return w + 6
  }

  const drawVideo = (s: S, y: number) => {
    const p = s.cur.p
    label(s, 0, 'VIDEO', p.videoCodecs ? p.videoCodecs.join(' ').toUpperCase() : 'ANY CODEC', y)
    let x = COL.x0
    for (const c of ['mp4', 'mov'])
      x += chip(c.toUpperCase(), x, y, p.containers?.includes(c) ? 1 : 0)
    if (p.editList === false) x += chip('NO EDIT LIST', x, y, 1, true)
    if (p.minWidth) chip(`≥ ${p.minWidth}×${p.minHeight}`, x, y, 1)
  }

  const drawBitrate = (s: S, y: number) => {
    const p = s.cur.p
    label(
      s,
      1,
      'BITRATE',
      p.minBitrate ? `≥ ${mbs(p.minBitrate)}` : p.maxBitrate ? `≤ ${mbs(p.maxBitrate)}` : 'ANY',
      y,
    )
    const lx = (bps: number) =>
      COL.x0 + ((COL.x1 - COL.x0) * Math.log(bps / BITRATE.lo)) / Math.log(BITRATE.hi / BITRATE.lo)
    const lo = p.minBitrate ?? BITRATE.lo
    const hi = p.maxBitrate ?? BITRATE.hi
    const top = y - 18
    // The scale: a tick per Mb/s decade step, the allowed window as an outlined bar.
    for (const v of [1e6, 2e6, 5e6, 1e7, 2e7, 5e7]) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(lx(v), top + 18, 1, 6)
      ctx.font = `11px ${mono}`
      ctx.textAlign = 'center'
      ctx.fillText(String(v / 1e6), lx(v), top + 36)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fillRect(COL.x0, top + 6, COL.x1 - COL.x0, 1)
    const any = !p.minBitrate && !p.maxBitrate
    ctx.fillStyle = any ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.85)'
    ctx.fillRect(lx(lo), top + 3, lx(hi) - lx(lo), 7)
    for (const [m, v] of [
      [p.minBitrate, lo],
      [p.maxBitrate, hi],
    ] as const)
      if (m) {
        ctx.fillStyle = RED
        ctx.fillRect(lx(v) - 1, top - 6, 2, 26)
      }
  }

  const drawFps = (s: S, y: number) => {
    const p = s.cur.p
    label(s, 2, 'FRAME RATE', p.fps ? p.fps.join(' · ') : 'ANY', y)
    const step = (COL.x1 - COL.x0) / FPS_TICKS.length
    FPS_TICKS.forEach((f, i) => {
      const on = p.fps ? (p.fps.includes(f) ? 1 : 0) : 0.3
      const h = 4 + 18 * on
      ctx.fillStyle = `rgba(255,255,255,${0.2 + 0.8 * on})`
      ctx.fillRect(COL.x0 + i * step, y - h, 2, h)
      ctx.font = `11px ${mono}`
      ctx.textAlign = 'left'
      ctx.fillText(String(f), COL.x0 + i * step + 6, y)
    })
  }

  const drawLoudness = (s: S, y: number) => {
    const p = s.cur.p
    label(
      s,
      3,
      'LOUDNESS',
      p.loudness ? `±${p.loudness.tolerance} LU  ${p.loudness.maxTruePeak} DBTP` : 'NOT SET',
      y,
    )
    const lx = (v: number) => COL.x0 + ((COL.x1 - COL.x0) * (v - LUFS.lo)) / (LUFS.hi - LUFS.lo)
    for (let v = LUFS.lo; v <= LUFS.hi; v++) {
      ctx.fillStyle = `rgba(255,255,255,${v % 2 === 0 ? 0.4 : 0.15})`
      ctx.fillRect(lx(v), y - (v % 2 === 0 ? 16 : 10), 1, v % 2 === 0 ? 16 : 10)
    }
    ctx.font = `11px ${mono}`
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    for (const v of [-30, -26, -22, -18, -14]) ctx.fillText(String(v), lx(v), y + 14)
    if (p.loudness) {
      const c = p.loudness.integrated
      const tol = p.loudness.tolerance
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1
      const w = Math.max(4, lx(c + tol) - lx(c - tol))
      ctx.strokeRect(lx(c - tol) + 0.5, y - 22.5, w, 26)
      ctx.fillStyle = RED
      ctx.fillRect(lx(c) - 1, y - 28, 2, 36)
    }
  }

  const drawAudio = (s: S, y: number) => {
    const p = s.cur.p
    label(
      s,
      4,
      'AUDIO',
      p.audio === 'none' ? 'SILENT' : p.audio === 'required' ? 'REQUIRED' : 'OPTIONAL',
      y,
    )
    let x = COL.x0
    for (const r of RATES) x += chip(`${r / 1000} KHZ`, x, y, p.sampleRates?.includes(r) ? 1 : 0)
    if (p.audioCodecs) x += chip('AAC', x, y, 1)
    if (p.minChannels) chip('STEREO', x, y, 1)
    if (p.audio === 'none') {
      ctx.fillStyle = RED
      ctx.fillRect(COL.x0, y - 6, x - COL.x0, 2)
    }
  }

  // The frame: a flat grey card in the placement's aspect, its safe zone in thin lines with red
  // corners; a dashed square when the placement sets no aspect.
  const BOX = { x: 560, y: 196, w: R - 560, h: 540 }
  const drawFrame = (s: S) => {
    const p = s.cur.p
    const aspect = aspectOf(p)
    const scale = aspect ? 1 : 0.88
    const w = Math.min(BOX.w, BOX.h * (aspect || 1)) * scale
    const h = w / (aspect || 1)
    const fx = BOX.x + (BOX.w - w) / 2
    const fy = BOX.y + (BOX.h - h) / 2
    ctx.fillStyle = '#3a3a3a'
    ctx.fillRect(fx, fy, w, h)
    ctx.setLineDash(aspect ? [] : [4, 6])
    ctx.strokeStyle = aspect ? '#fff' : 'rgba(255,255,255,0.5)'
    ctx.lineWidth = 1
    ctx.strokeRect(fx + 0.5, fy + 0.5, w - 1, h - 1)
    ctx.setLineDash([])
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(scramble(p.aspect ?? 'ANY ASPECT', s.since / DECODE, s.frame, 3), fx, fy - 10)
    const sa = p.safeArea
    if (!sa) return
    const m = { top: sa.top * h, right: sa.right * w, bottom: sa.bottom * h, left: sa.left * w }
    const sx = fx + m.left
    const sy = fy + m.top
    const sw = w - m.left - m.right
    const sh = h - m.top - m.bottom
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1)
    ctx.fillStyle = RED
    for (const [px, py, dx, dy] of [
      [sx, sy, 1, 1],
      [sx + sw, sy, -1, 1],
      [sx, sy + sh, 1, -1],
      [sx + sw, sy + sh, -1, -1],
    ] as const) {
      ctx.fillRect(dx > 0 ? px - 5 : px - 9, dy > 0 ? py - 5 : py + 3, 14, 2)
      ctx.fillRect(dx > 0 ? px - 5 : px + 3, dy > 0 ? py - 5 : py - 9, 2, 14)
    }
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'center'
    ctx.fillStyle = '#cfcfcf'
    ctx.fillText(`${Math.round(sa.top * 100)}%`, fx + w / 2, fy + m.top / 2 + 5)
    ctx.fillText(`${Math.round(sa.bottom * 100)}%`, fx + w / 2, fy + h - m.bottom / 2 + 5)
    ctx.fillText(`${Math.round(sa.left * 100)}%`, fx + m.left / 2, fy + h / 2 + 5)
    ctx.fillText(`${Math.round(sa.right * 100)}%`, fx + w - m.right / 2, fy + h / 2 + 5)
  }

  // The placements in order above the frame, the current one bright, and a playhead along them.
  const drawList = (s: S) => {
    const y = 136
    const seg = BOX.w / count
    ctx.font = `11px ${mono}`
    ctx.textAlign = 'left'
    ids.forEach((_, i) => {
      const x = BOX.x + i * seg
      ctx.fillStyle = i === s.n ? '#fff' : 'rgba(255,255,255,0.25)'
      ctx.fillRect(x, y, seg - 4, i === s.n ? 3 : 1)
      ctx.fillStyle = i === s.n ? '#fff' : '#5a5a5a'
      ctx.fillText(String(i + 1).padStart(2, '0'), x, y + 18)
    })
    const head = BOX.x + (s.t / duration) * BOX.w
    ctx.fillStyle = RED
    ctx.fillRect(Math.round(head) - 1, y - 8, 2, 14)
  }

  return {
    async render(t, o) {
      const s = state(t, o.frame)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      drawFrame(s)
      drawList(s)
      drawVideo(s, rowY(0))
      drawBitrate(s, rowY(1))
      drawFps(s, rowY(2))
      drawLoudness(s, rowY(3))
      drawAudio(s, rowY(4))
      house.bigWord({
        text: SHORT[s.cur.id] ?? s.cur.id,
        corner: 'tl',
        since: s.since,
        until: STEP - s.since,
        frame: o.frame,
        maxWidth: 900,
      })
      house.bigWord({
        text: defining(s.cur.p),
        corner: 'br',
        since: s.since - 0.08,
        until: STEP - s.since,
        frame: o.frame + 5,
      })
      house.note(`${domainOf(s.cur.p.source)}, read ${readDate(s.cur.p.source)}`)
      const p = s.cur.p
      house.hud(
        t,
        o.frame,
        `${s.cur.id}   ${
          p.maxBytes
            ? `MAX ${p.maxBytes >= 1e9 ? `${p.maxBytes / 1e9} GB` : `${p.maxBytes / 1e6} MB`}`
            : 'NO SIZE LIMIT'
        }`,
        `${String(s.n + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}   delivery/placements.json`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t, 0)
      return `${String(s.n + 1).padStart(2, '0')}/${String(count).padStart(2, '0')}  ${s.cur.id}`
    },
    inspect(t) {
      const s = state(t, 0)
      return { id: 'placement', placement: s.cur.id, defining: defining(s.cur.p) }
    },
  }
}

export default formatPlacementSpecs
