// review-av-timeline: a 6 s film made in code (preview/make.ts), with five hits and
// the third cut 4 frames late on purpose, reviewed by the item's own tools/av-review.ts. The film
// plays in its panel with its sound; the tool's timeline.png (spectrogram, waveform with onsets,
// picture change), recoloured to the house's greys, scrolls past the playhead as three lanes, like
// audio-beat-clock's; the tool's printed report is the list of moments, and each moment's verdict
// and offset scramble in at the corners as the playhead reaches it. The late hit reads in red.

import { AREA, createHouse, frameLabel, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const FILM = 'audio/review-film.mp4'
const L = AREA.left
const R = AREA.right
const PLAYHEAD = 300
const PX_PER_S = 330
/** The tool's timeline.png: its lanes' rows (av-review.ts: pad 24, spectrum 220, waveform 90, a
 * 24 px gap, picture change 120). */
const SRC = { spectrum: [24, 244], waveform: [244, 334], change: [358, 478] } as const
const LANES = [
  { key: 'spectrum', label: 'SPECTRUM', top: 452, height: 128 },
  { key: 'waveform', label: 'WAVEFORM · ONSETS', top: 592, height: 54 },
  { key: 'change', label: 'PICTURE CHANGE', top: 660, height: 70 },
] as const

type Moment = {
  t: number
  sound: number | null
  picture: number | null
  gap: number | null
  frames: number | null
  out: boolean
}

/** The lines av-review prints for each --at moment. */
const parseReport = (text: string): Moment[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('t '))
    .map((l) => {
      const num = (re: RegExp) => {
        const m = re.exec(l)
        return m ? Number(m[1]) : null
      }
      return {
        t: Number(/^t ([\d.]+)/.exec(l)?.[1]),
        sound: num(/sound onset ([\d.]+)/),
        picture: num(/picture peak ([\d.]+)/),
        gap: num(/picture − sound ([+-]?\d+) ms/),
        frames: num(/\(([+-]?[\d.]+) frames\)/),
        out: l.includes('out of sync'),
      }
    })

const reviewAvTimeline: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`review-av-timeline has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const frames = Math.round(duration * Number(host.manifest.fps))
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`
  const monoBold = `"${FONT.monoBold}"`
  const moments = parseReport(
    new TextDecoder().decode(await host.io.read('audio/review-av/report.txt')),
  )
  if (!moments.length)
    throw new Error('audio/review-av/report.txt has no moments; run its preview/make.ts')

  // The tool's timeline, recoloured: greys from its luminance on black, its yellow onset ticks
  // white. Its red moment lines turn grey; the preview draws its own.
  if (!host.io.image) throw new Error('The review-av-timeline preview needs io.image')
  const img = await host.io.image('audio/review-av/timeline.png')
  const tl = host.io.canvas(img.width, img.height)
  const tctx = tl.getContext('2d') as OffscreenCanvasRenderingContext2D
  const data = tctx.createImageData(img.width, img.height)
  const px = img.data
  for (let i = 0; i < img.width * img.height; i++) {
    const r = px[i * 4] as number
    const g = px[i * 4 + 1] as number
    const b = px[i * 4 + 2] as number
    const y = Math.floor(i / img.width)
    const x = i % img.width
    // The tool's label inside the waveform lane goes.
    const label = y >= 244 && y < 262 && x < 130
    let o: [number, number, number]
    if (label) o = [0, 0, 0]
    else if (r > 200 && g > 160 && b < 120 && y >= 244 && y < 256) o = [255, 255, 255]
    else {
      const lum = Math.max(0, (0.3 * r + 0.59 * g + 0.11 * b - 17) / 238)
      const v = Math.round(255 * lum ** 1.25)
      o = [v, v, v]
    }
    data.data[i * 4] = o[0]
    data.data[i * 4 + 1] = o[1]
    data.data[i * 4 + 2] = o[2]
    data.data[i * 4 + 3] = 255
  }
  tctx.putImageData(data, 0, 0)
  const srcPerS = img.width / duration

  // The film's frames, for its panel.
  if (!host.io.video) throw new Error('The review-av-timeline preview needs io.video')
  const film = await host.io.video(FILM)
  const fc = host.io.canvas(film.width, film.height)
  const fctx = fc.getContext('2d') as OffscreenCanvasRenderingContext2D
  const fimg = fctx.createImageData(film.width, film.height)

  /** The moment the playhead has most recently reached (from 0.1 s before it). */
  const momentAt = (t: number) => {
    let i = moments.length - 1
    for (let j = 0; j < moments.length; j++) if (t >= (moments[j] as Moment).t - 0.1) i = j
    const m = moments[i] as Moment
    const next = moments[(i + 1) % moments.length] as Moment
    const since = (((t - (m.t - 0.1)) % duration) + duration) % duration
    const until = (((next.t - 0.1 - t) % duration) + duration) % duration || duration
    return { i, m, since, until }
  }
  const verdict = (m: Moment) =>
    m.out && m.frames !== null
      ? `${Math.abs(m.frames).toFixed(0)} FRAMES ${m.frames > 0 ? 'LATE' : 'EARLY'}`
      : 'IN SYNC'
  const ms = (m: Moment) =>
    m.gap === null ? '—' : `${m.gap >= 0 ? '+' : '−'}${Math.abs(m.gap)} MS`

  const drawLanes = (t: number) => {
    const xOf = (time: number) => PLAYHEAD + (time - t) * PX_PER_S
    ctx.save()
    ctx.beginPath()
    ctx.rect(L, 0, R - L, height)
    ctx.clip()
    for (const lane of LANES) {
      const [s0, s1] = SRC[lane.key]
      for (const k of [-1, 0, 1]) {
        const x0 = xOf(k * duration)
        ctx.drawImage(
          tl,
          0,
          s0,
          img.width,
          s1 - s0,
          x0,
          lane.top,
          (img.width / srcPerS) * PX_PER_S,
          lane.height,
        )
      }
      // What is still to play, dimmed.
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(PLAYHEAD + 2, lane.top, R - PLAYHEAD, lane.height)
    }
    // Each moment: a line through the lanes, a red marker under them and its offset above them,
    // like beat-clock's words.
    const top = LANES[0].top
    const bottom = LANES[2].top + LANES[2].height
    for (const k of [-1, 0, 1])
      for (const m of moments) {
        const x = xOf(m.t + k * duration)
        if (x < L - 200 || x > R + 20) continue
        const past = m.t + k * duration <= t
        ctx.fillStyle = past ? 'rgba(255,59,31,0.9)' : 'rgba(255,59,31,0.35)'
        ctx.fillRect(Math.round(x), top, 1, bottom - top)
        ctx.fillStyle = past ? (m.out ? RED : '#fff') : '#6a6a6a'
        ctx.fillRect(Math.round(x), top - 42, 2, 20)
        ctx.font = `15px ${mono}`
        ctx.textAlign = 'left'
        ctx.fillText(`${m.t.toFixed(3)}  ${ms(m)}`, x + 6, top - 26)
        ctx.fillStyle = past ? RED : '#7a2a1c'
        ctx.beginPath()
        ctx.moveTo(x - 6, bottom + 14)
        ctx.lineTo(x + 6, bottom + 14)
        ctx.lineTo(x, bottom + 4)
        ctx.fill()
      }
    ctx.restore()
    for (const lane of LANES) {
      ctx.font = `13px ${mono}`
      ctx.textAlign = 'left'
      const w = ctx.measureText(lane.label).width + 8
      ctx.fillStyle = '#000'
      ctx.fillRect(L, lane.top, w, 18)
      ctx.fillStyle = '#9a9a9a'
      ctx.fillText(lane.label, L + 3, lane.top + 13)
    }
    // The playhead: now.
    const near = momentAt(t)
    ctx.fillStyle = near.since < 0.25 && near.m.out ? RED : '#fff'
    ctx.fillRect(PLAYHEAD - 1, top - 46, 3, bottom - top + 60)
  }

  const drawFilm = async (t: number, frame: number) => {
    const fx = 600
    const fy = 150
    const fw = R - fx
    const fh = (fw * film.height) / film.width
    const i = Math.min(film.frames - 1, Math.round(t * film.fps))
    fimg.data.set(await film.frame(i))
    fctx.putImageData(fimg, 0, 0)
    ctx.drawImage(fc, fx, fy, fw, fh)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.strokeRect(fx - 0.5, fy - 0.5, fw + 1, fh + 1)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText('review-film.mp4', fx, fy - 10)
    ctx.textAlign = 'right'
    ctx.fillText(frameLabel(frame, frames), fx + fw, fy - 10)
    return fh
  }

  // The report: one line per moment, the current one bright.
  const drawReport = (t: number) => {
    const cur = momentAt(t).i
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText('node tools/av-review.ts film.mp4 --at …', L, 172)
    moments.forEach((m, i) => {
      const y = 208 + i * 40
      const on = i === cur
      ctx.font = `18px ${on ? monoBold : mono}`
      ctx.fillStyle = on ? (m.out ? RED : '#fff') : '#5a5a5a'
      ctx.fillText(`t ${m.t.toFixed(3)}`, L, y)
      ctx.font = `13px ${mono}`
      ctx.fillStyle = on ? '#cfcfcf' : '#4a4a4a'
      ctx.fillText(
        `sound ${m.sound?.toFixed(3) ?? '—'}  picture ${m.picture?.toFixed(3) ?? '—'}`,
        L + 128,
        y - 2,
      )
      ctx.textAlign = 'right'
      ctx.font = `18px ${on ? monoBold : mono}`
      ctx.fillStyle = on ? (m.out ? RED : '#fff') : '#5a5a5a'
      ctx.fillText(ms(m), 572, y)
      ctx.textAlign = 'left'
    })
  }

  return {
    async render(t, o) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      await drawFilm(t, o.frame)
      drawReport(t)
      drawLanes(t)
      const cur = momentAt(t)
      house.bigWord({
        text: verdict(cur.m),
        corner: 'tl',
        maxWidth: 940,
        since: cur.since,
        until: cur.until,
        frame: o.frame,
        color: cur.m.out ? RED : '#fff',
      })
      house.bigWord({
        text: ms(cur.m),
        corner: 'br',
        since: cur.since - 0.06,
        until: cur.until,
        frame: o.frame + 3,
      })
      house.note(
        cur.m.out
          ? `the picture lands ${cur.m.gap} ms after the sound: out of sync`
          : `sound and picture hit together at ${cur.m.t.toFixed(2)} s`,
      )
      house.hud(
        t,
        o.frame,
        `${moments.length} MOMENTS   ${moments.filter((m) => m.out).length} OUT OF SYNC   SYNC: −20 TO +45 MS`,
        'tools/av-review.ts',
      )
      return [{ color: canvas }]
    },
    status(t) {
      const cur = momentAt(t)
      return `t ${cur.m.t.toFixed(2)}  ${ms(cur.m).toLowerCase()}`
    },
    inspect(t) {
      const cur = momentAt(t)
      return { id: 'review', moment: cur.m.t, gap: cur.m.gap, out: cur.m.out }
    },
    async audio() {
      return [{ src: 'audio/review-film.wav', at: 0 }]
    },
  }
}

export default reviewAvTimeline
