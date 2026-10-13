// format-broadcast-slate: a broadcast preroll as the film draws it at negative t. The item's
// drawSlate paints the clock slate (the spot's details and the seconds left) into a 16:9 picture,
// shown flat and full width; its last two seconds are black, and at t = 0 the programme starts, a
// plain grey card. The loop is the preroll's last 4.5 s and the programme's first 1.5; the
// timecode and the strip of the delivered file move through all of it.

import { drawSlate, type SlateFields } from '../../previews/src/delivery/slate.ts'
import { AREA, createHouse, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = AREA.left
const R = AREA.right
/** The preview's t 0 is this many seconds before the programme. */
const LEAD = 4.5
const PREROLL = 10
const BLACK = 2
const FIELDS: SlateFields = {
  Title: 'Plugin previews',
  Client: 'Shaderera',
  Agency: 'In house',
  Duration: '6"',
  Clock: 'SHD/PREV001/006',
}
const SLATE = { w: 1920, h: 1080 }
/** The 16:9 frame on screen: the picture's full width, centred above the strip. */
const FRAME = { x: L, y: 160, w: R - L, h: ((R - L) * 9) / 16 }

const timecode = (s: number, fps: number) => {
  // The programme starts at 10:00:00:00.
  const total = Math.round((10 * 3600 + s) * fps)
  const f = ((total % fps) + fps) % fps
  const secs = Math.floor(total / fps)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}:${p(f)}`
}

const formatBroadcastSlate: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`format-broadcast-slate has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const fps = Number(host.manifest.fps)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const slate = host.io.canvas(SLATE.w, SLATE.h)
  const sctx = slate.getContext('2d') as OffscreenCanvasRenderingContext2D
  const mono = `"${FONT.mono}"`

  const state = (t: number) => {
    const ts = t - LEAD
    const phase: 'slate' | 'black' | 'programme' =
      ts < -BLACK ? 'slate' : ts < 0 ? 'black' : 'programme'
    const start = { slate: -LEAD, black: -BLACK, programme: 0 }[phase]
    const end = { slate: -BLACK, black: 0, programme: duration - LEAD }[phase]
    return { t, ts, phase, since: ts - start, until: end - ts }
  }
  type S = ReturnType<typeof state>

  // The delivered file as a strip: the preroll's slate and black, then the programme.
  const drawStrip = (s: S, y: number) => {
    const from = -PREROLL
    const to = duration - LEAD
    const x = (v: number) => L + ((v - from) / (to - from)) * (R - L)
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(L, y, R - L, 1)
    ctx.font = `12px ${mono}`
    ctx.textAlign = 'left'
    for (const [v, label] of [
      [-PREROLL, 'PREROLL −10 S  SLATE'],
      [-BLACK, 'BLACK'],
      [0, 'PROGRAMME'],
    ] as const) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillRect(Math.round(x(v)), y - 8, 1, 16)
      ctx.fillText(label, x(v) + 6, y - 6)
    }
    for (let v = -PREROLL; v <= to; v++) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(Math.round(x(v)), y, 1, 5)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(x(from), y - 1, x(s.ts) - x(from), 3)
    ctx.fillStyle = RED
    ctx.fillRect(Math.round(x(s.ts)) - 1, y - 14, 2, 28)
  }

  const WORD = { slate: 'SLATE', black: 'TO BLACK', programme: 'ON AIR' } as const
  const NOTE = {
    slate: 'the spot’s details, drawn by the film at negative t',
    black: 'the last two seconds go to black',
    programme: 't = 0, and the programme starts',
  } as const

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      // The frame: the slate exactly as the item draws it, then the programme's grey card.
      const { x, y, w, h } = FRAME
      if (s.ts < 0) {
        drawSlate(sctx, s.ts, {
          width: SLATE.w,
          height: SLATE.h,
          fields: FIELDS,
          family: `"${FONT.sans}"`,
        })
        ctx.drawImage(slate, x, y, w, h)
      } else {
        ctx.fillStyle = '#3a3a3a'
        ctx.fillRect(x, y, w, h)
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 1
      ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1)
      ctx.font = `13px ${mono}`
      ctx.textAlign = 'left'
      ctx.fillStyle = '#8a8a8a'
      ctx.fillText(`16:9  ${SLATE.w}×${SLATE.h}`, x, y - 10)
      ctx.textAlign = 'right'
      ctx.fillText(s.ts < 0 ? `drawSlate(ctx, ${s.ts.toFixed(2)})` : 'the film', x + w, y - 10)
      drawStrip(s, y + h + 44)
      house.bigWord({
        text: WORD[s.phase],
        corner: 'tl',
        since: s.since,
        until: s.until,
        frame: o.frame,
        maxWidth: 760,
      })
      house.bigWord({
        text: timecode(s.ts, fps),
        corner: 'br',
        since: t < 0.3 ? t : 9,
        until: duration - t,
        frame: o.frame,
      })
      house.note(NOTE[s.phase])
      house.hud(
        t,
        o.frame,
        `CLOCK ${FIELDS.Clock}   PREROLL ${PREROLL} S, BLACK ${BLACK} S`,
        `t ${s.ts.toFixed(3)}   FILL SOURCE`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return s.phase === 'slate'
        ? `slate  ${Math.ceil(-s.ts)}`
        : s.phase === 'black'
          ? 'black'
          : 'programme'
    },
    inspect(t) {
      const s = state(t)
      return { id: 'slate', t: s.ts, phase: s.phase, seconds: s.ts < 0 ? Math.ceil(-s.ts) : 0 }
    },
  }
}

export default formatBroadcastSlate
