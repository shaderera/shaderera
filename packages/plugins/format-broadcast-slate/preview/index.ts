// format-broadcast-slate: a broadcast preroll as the film draws it at negative t. The item's
// drawSlate paints the clock slate into a 16:9 picture on a monitor (the spot's details and the
// seconds left), the last two seconds go to black, and at t = 0 the programme starts: a luminous
// point field. The loop is the preroll's last 4.5 s and the programme's first 1.5; the camera's
// slow turn round the monitor, the cloud behind it, the timecode and the strip of the delivered
// file keep moving through all of it.

import { drawSlate, type SlateFields } from '../../previews/src/delivery/slate.ts'
import { AREA, createHouse, hash, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = AREA.left
const R = AREA.right
const TAU = Math.PI * 2
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
const PROG = { w: 960, h: 540 }
const lerp = (a: number, b: number, x: number) => a + (b - a) * x

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

  // The programme, into its own 16:9 canvas: a luminous field of points rushing at the camera.
  const prog = host.io.canvas(PROG.w, PROG.h)
  const pctx = prog.getContext('2d') as OffscreenCanvasRenderingContext2D
  const drawProgramme = (s: S) => {
    const ctx = pctx
    const [x, y, w, h] = [0, 0, PROG.w, PROG.h]
    ctx.fillStyle = '#000'
    ctx.fillRect(x, y, w, h)
    ctx.globalCompositeOperation = 'lighter'
    const ph = s.ts
    const cx = x + w / 2
    const cy = y + h * 0.42
    const focal = w * 0.8
    const open = Math.min(1, s.ts / 0.35)
    for (let zi = 0; zi < 46; zi++) {
      const z = 1 + ((((zi * 0.6 - ph * 6) % 27.6) + 27.6) % 27.6)
      const fade = Math.min(1, (28 - z) / 6) * Math.min(1, z / 1.5) * open
      for (let xi = -30; xi <= 30; xi++) {
        const wx = xi * 0.35
        const wy = -1.2 + 0.5 * Math.sin(wx * 0.7 + z * 0.4 + ph * 3) * Math.cos(z * 0.3 - ph * 2)
        const sx = cx + (wx / z) * focal
        const sy = cy - (wy / z) * focal
        const d = 1 + 5 / z
        const tint =
          (xi + zi) % 13 === 0
            ? '255,200,170'
            : (xi + zi) % 17 === 0
              ? '200,180,255'
              : '255,255,255'
        ctx.fillStyle = `rgba(${tint},${0.85 * fade})`
        ctx.fillRect(sx - d / 2, sy - d / 2, d, d)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  // The camera: a slow yaw, a whole cycle a loop. The monitor is a panel at depth D, drawn as
  // vertical strips in perspective; a dim cloud of points behind it moves against it.
  const D = 4
  const FOCAL = 980
  const CY = 448
  const cloud = Array.from({ length: 900 }, (_, i) => [
    (hash(i * 1.3) - 0.5) * 22,
    (hash(i * 2.7 + 5) - 0.5) * 9,
    D + 1 + hash(i * 4.1 + 9) * 10,
  ])
  const yawAt = (t: number) => 0.3 * Math.sin((t / duration) * TAU)
  const project = (x: number, y: number, z: number, yaw: number) => {
    const xr = x * Math.cos(yaw) - (z - D) * Math.sin(yaw)
    const zr = x * Math.sin(yaw) + (z - D) * Math.cos(yaw) + D
    return [width / 2 + (xr / zr) * FOCAL, CY - (y / zr) * FOCAL, zr] as const
  }
  const drawCloud = (t: number) => {
    const yaw = yawAt(t)
    ctx.globalCompositeOperation = 'lighter'
    for (const [i, [x, y, z]] of cloud.entries()) {
      const drift = (((x as number) + (t / duration) * 22 * (i % 2 ? 1 : -1) + 33) % 22) - 11
      const [sx, sy, zr] = project(drift, y as number, z as number, yaw)
      const tw = 0.5 + 0.5 * Math.sin(t * 4 + i)
      const a = (0.22 + 0.5 * tw) * Math.min(1, 12 / zr)
      const d = 1 + 6 / zr
      ctx.fillStyle = i % 23 === 0 ? `rgba(200,180,255,${a})` : `rgba(255,255,255,${a})`
      ctx.fillRect(sx - d / 2, sy - d / 2, d, d)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  /** Draws `src` as the monitor panel, `pw` world units wide; returns its corners on screen. */
  const drawPanel = (src: OffscreenCanvas, t: number, pw: number) => {
    const yaw = yawAt(t)
    const ph = (pw * 9) / 16
    const strips = 72
    const corners = [
      project(-pw / 2, ph / 2, D, yaw),
      project(pw / 2, ph / 2, D, yaw),
      project(pw / 2, -ph / 2, D, yaw),
      project(-pw / 2, -ph / 2, D, yaw),
    ]
    ctx.fillStyle = '#000'
    ctx.beginPath()
    for (const [i, c] of corners.entries()) i ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1])
    ctx.fill()
    for (let i = 0; i < strips; i++) {
      const x0 = -pw / 2 + (pw * i) / strips
      const x1 = -pw / 2 + (pw * (i + 1)) / strips
      const a = project(x0, ph / 2, D, yaw)
      const b = project(x1, -ph / 2, D, yaw)
      const c = project(x0, -ph / 2, D, yaw)
      const top = a[1]
      const bottom = (c[1] + b[1]) / 2
      ctx.drawImage(
        src,
        (src.width * i) / strips,
        0,
        src.width / strips + 1,
        src.height,
        a[0],
        top,
        b[0] - a[0] + 0.6,
        bottom - top,
      )
    }
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const [i, c] of corners.entries()) i ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1])
    ctx.closePath()
    ctx.stroke()
    return corners
  }

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
      [0, 'PROGRAMME  10:00:00:00'],
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
      drawCloud(t)
      // The monitor: the slate as the item draws it, then the programme.
      let src: OffscreenCanvas
      if (s.ts < 0) {
        drawSlate(sctx, s.ts, {
          width: SLATE.w,
          height: SLATE.h,
          fields: FIELDS,
          family: `"${FONT.sans}"`,
        })
        src = slate
      } else {
        drawProgramme(s)
        src = prog
      }
      const corners = drawPanel(src, t, 3.5)
      const [tl, tr, br] = corners as unknown as [number[], number[], number[]]
      // Red brackets on the seconds while the slate counts.
      if (s.phase === 'slate') {
        const bx = lerp(tl[0] as number, tr[0] as number, 0.9)
        const by = lerp(tr[1] as number, br[1] as number, 0.85)
        ctx.fillStyle = RED
        ctx.fillRect(bx + 10, by - 98, 2, 14)
        ctx.fillRect(bx - 4, by - 98, 16, 2)
        ctx.fillRect(bx + 10, by + 8, 2, -14)
        ctx.fillRect(bx - 4, by + 8, 16, 2)
      }
      ctx.font = `13px ${mono}`
      ctx.textAlign = 'left'
      ctx.fillStyle = '#8a8a8a'
      ctx.fillText(`16:9  ${SLATE.w}×${SLATE.h}`, tl[0] as number, (tl[1] as number) - 10)
      ctx.textAlign = 'right'
      ctx.fillText(
        s.ts < 0 ? `drawSlate(ctx, ${s.ts.toFixed(2)})` : 'the film',
        tr[0] as number,
        (tr[1] as number) - 10,
      )
      drawStrip(s, 752)
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
