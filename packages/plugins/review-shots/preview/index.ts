// review-shots: a 6 s film made in code (preview/make.ts), five shots each with its own grade and a
// known camera move, measured by the plugin's own tools/review-shots.py. The film plays in its
// panel; under it the shots lie on a timeline, each as its frame from the tool's contact sheet,
// with the cuts it found in red and its move under it. The shot playing is lit, and its numbers
// stand beside the film: the move, zoom and pan, and its levels on a 0–255 scale.

import { createHouse, frameLabel, L, R, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const FILM = 'audio/review-shots.mp4'
const DIR = 'audio/review-shots'
/** The tool's sheet: 6 columns of 320 px frames, each with a 22 px label under it. */
const SHEET = { width: 320, label: 22 }
const PANEL = { x: L, y: 176, width: 620 }
const STRIP = { top: 600, height: 100 }

type Shot = {
  id: string
  start: number
  end: number
  move: string[] | null
  zoom: number | null
  pan: [number, number] | null
  black: number
  white: number
  luma: number
  contrast: number
  saturation: number
  labA: number
  labB: number
}

const reviewShots: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`review-shots has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const frames = Math.round(duration * Number(host.manifest.fps))
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`
  const monoBold = `"${FONT.monoBold}"`

  // The tool's output, as it wrote it.
  const doc = JSON.parse(new TextDecoder().decode(await host.io.read(`${DIR}/shots.json`))) as {
    shots: Shot[]
  }
  const shots = doc.shots
  if (!host.io.image || !host.io.video)
    throw new Error('The review-shots preview needs io.image and io.video')
  const img = await host.io.image(`${DIR}/sheet-1.jpg`)
  const sheet = host.io.canvas(img.width, img.height)
  const sctx = sheet.getContext('2d') as OffscreenCanvasRenderingContext2D
  const data = sctx.createImageData(img.width, img.height)
  data.data.set(img.data)
  sctx.putImageData(data, 0, 0)
  const thumbHeight = img.height - SHEET.label

  const film = await host.io.video(FILM)
  const fc = host.io.canvas(film.width, film.height)
  const fctx = fc.getContext('2d') as OffscreenCanvasRenderingContext2D
  const fimg = fctx.createImageData(film.width, film.height)
  const panelHeight = (PANEL.width * film.height) / film.width

  const shotAt = (t: number) => {
    const i = Math.max(
      0,
      shots.findLastIndex((s) => t >= s.start),
    )
    const s = shots[i] as Shot
    return { i, s, since: t - s.start, until: s.end - t }
  }
  const xOf = (time: number) => L + (time / duration) * (R - L)
  const sign = (v: number, digits: number) => {
    const n = Math.abs(v).toFixed(digits)
    return Number(n) === 0 ? n : `${v < 0 ? '−' : '+'}${n}`
  }
  const moveOf = (s: Shot) => (s.move ?? ['—']).join(' + ')
  /** The number that says the most about the move: the zoom for a push or pull, else the pan. */
  const rate = (s: Shot) => {
    if (!s.move || !s.pan || s.zoom === null) return '—'
    if (s.move.includes('push') || s.move.includes('pull')) return `${sign(s.zoom, 1)} %/S`
    if (s.move.includes('pan')) return `${sign(s.pan[0], 2)} W/S`
    if (s.move.includes('tilt')) return `${sign(s.pan[1], 2)} W/S`
    return '0 %/S'
  }

  const drawFilm = async (t: number, frame: number) => {
    const i = Math.min(film.frames - 1, Math.round(t * film.fps))
    fimg.data.set(await film.frame(i))
    fctx.putImageData(fimg, 0, 0)
    ctx.drawImage(fc, PANEL.x, PANEL.y, PANEL.width, panelHeight)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.strokeRect(PANEL.x - 0.5, PANEL.y - 0.5, PANEL.width + 1, panelHeight + 1)
    ctx.font = `13px ${mono}`
    ctx.fillStyle = '#8a8a8a'
    ctx.textAlign = 'left'
    ctx.fillText('review-shots.mp4', PANEL.x, PANEL.y - 10)
    ctx.textAlign = 'right'
    ctx.fillText(frameLabel(frame, frames), PANEL.x + PANEL.width, PANEL.y - 10)
  }

  // The shot playing, in numbers, as shots.json has them.
  const drawNumbers = (s: Shot, i: number) => {
    const x = PANEL.x + PANEL.width + 32
    const rows: [string, string][] = [
      ['SHOT', `${i + 1} / ${shots.length}`],
      ['FROM', `${s.start.toFixed(2)} S`],
      ['TO', `${s.end.toFixed(2)} S`],
      ['MOVE', moveOf(s).toUpperCase()],
      ['ZOOM', s.zoom === null ? '—' : `${sign(s.zoom, 2)} %/S`],
      ['PAN X', s.pan ? sign(s.pan[0], 3) : '—'],
      ['PAN Y', s.pan ? sign(s.pan[1], 3) : '—'],
      ['SAT', s.saturation.toFixed(1)],
      ['LAB', `${sign(s.labA, 1)} ${sign(s.labB, 1)}`],
    ]
    ctx.textAlign = 'left'
    rows.forEach(([k, v], j) => {
      const y = PANEL.y + 14 + j * 31
      ctx.font = `13px ${mono}`
      ctx.fillStyle = '#7a7a7a'
      ctx.fillText(k, x, y)
      ctx.font = `17px ${j === 3 ? monoBold : mono}`
      ctx.fillStyle = j === 3 ? RED : '#fff'
      ctx.fillText(v, x + 76, y)
    })
    // Levels on a 0–255 scale: the black to white span, luma, and luma ± contrast.
    const top = PANEL.y + panelHeight - 34
    const X = (v: number) => x + (v / 255) * (R - x)
    ctx.fillStyle = '#2a2a2a'
    ctx.fillRect(x, top, R - x, 10)
    ctx.fillStyle = '#9a9a9a'
    ctx.fillRect(X(s.black), top, X(s.white) - X(s.black), 10)
    ctx.fillStyle = '#fff'
    ctx.fillRect(
      X(s.luma - s.contrast),
      top + 14,
      X(s.luma + s.contrast) - X(s.luma - s.contrast),
      2,
    )
    ctx.fillStyle = RED
    ctx.fillRect(X(s.luma) - 1, top - 4, 3, 22)
    ctx.font = `13px ${mono}`
    ctx.fillStyle = '#7a7a7a'
    ctx.fillText(
      `BLACK ${s.black.toFixed(0)}  LUMA ${s.luma.toFixed(0)}  WHITE ${s.white.toFixed(0)}`,
      x,
      top - 12,
    )
  }

  // The shots on the film's timeline, each as its sheet frame; the cuts in red.
  const drawStrip = (t: number, cur: number) => {
    shots.forEach((s, k) => {
      const x0 = xOf(s.start) + 1
      const x1 = xOf(s.end) - 1
      const w = x1 - x0
      const sh = Math.min(thumbHeight, (SHEET.width * STRIP.height) / w)
      ctx.globalAlpha = k === cur ? 1 : 0.35
      ctx.drawImage(
        sheet,
        k * SHEET.width,
        (thumbHeight - sh) / 2,
        SHEET.width,
        sh,
        x0,
        STRIP.top,
        w,
        STRIP.height,
      )
      ctx.globalAlpha = 1
      ctx.font = `${k === cur ? `15px ${monoBold}` : `15px ${mono}`}`
      ctx.textAlign = 'left'
      ctx.fillStyle = k === cur ? '#fff' : '#6a6a6a'
      ctx.fillText(moveOf(s).toUpperCase(), x0 + 4, STRIP.top + STRIP.height + 24)
      ctx.font = `13px ${mono}`
      ctx.fillText(rate(s).toLowerCase(), x0 + 4, STRIP.top + STRIP.height + 44)
      if (k > 0) {
        const x = xOf(s.start)
        ctx.fillStyle = RED
        ctx.fillRect(Math.round(x) - 1, STRIP.top - 28, 2, STRIP.height + 34)
        ctx.font = `13px ${mono}`
        ctx.fillText(`CUT ${s.start.toFixed(2)}`, x + 6, STRIP.top - 16)
      }
    })
    ctx.fillStyle = '#fff'
    ctx.fillRect(Math.round(xOf(t)) - 1, STRIP.top - 6, 3, STRIP.height + 12)
  }

  return {
    async render(t, o) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      await drawFilm(t, o.frame)
      const cur = shotAt(t)
      drawNumbers(cur.s, cur.i)
      drawStrip(t, cur.i)
      house.bigWord({
        text: moveOf(cur.s),
        corner: 'tl',
        maxWidth: 700,
        since: cur.since,
        until: cur.until,
        frame: o.frame,
      })
      house.bigWord({
        text: rate(cur.s),
        corner: 'br',
        since: cur.since - 0.06,
        until: cur.until,
        frame: o.frame + 3,
      })
      house.note(
        cur.i === 0
          ? 'each shot measured from the film itself'
          : `a cut found at ${cur.s.start.toFixed(2)} s`,
      )
      house.hud(
        t,
        o.frame,
        `${shots.length} SHOTS   ${shots.length - 1} CUTS   PYSCENEDETECT + OPTICAL FLOW`,
        'tools/review-shots.py',
      )
      return [{ color: canvas }]
    },
    status(t) {
      const { s } = shotAt(t)
      return `${s.id}  ${moveOf(s)}`
    },
    inspect(t) {
      const { s } = shotAt(t)
      return { id: 'shots', shot: s.id, move: s.move, zoom: s.zoom, pan: s.pan }
    },
  }
}

export default reviewShots
