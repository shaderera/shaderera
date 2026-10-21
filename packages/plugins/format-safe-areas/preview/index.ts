// format-safe-areas: one shot relaid for 16:9, 1:1 and 9:16, with hard cuts between formats and
// platforms. In each, safeArea gives the box text may use (thin white lines, the margins it returns
// dimmed, red brackets on its corners), the two big words hold its corners, and a thin grey grid on
// a wall sits behind them. The grid drifts a whole number of cells a loop. In 'all' the vertical
// frame then takes each platform's zone; a state holds one platform.

import { AREA, createHouse, RED } from '../../previews/src/house.ts'
import { type Platform, safeArea } from '../../previews/src/layout/frame.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = AREA.left
const R = AREA.right
/** The stage the frame sits in. */
const STAGE = { top: 120, bottom: 850 }
const FOV = (40 * Math.PI) / 180
const WIDE = 16 / 9
const TALL = 9 / 16
/** The wall at distance 1: a frame sees 9 cells of it top to bottom. */
const CELL = (2 * Math.tan(FOV / 2)) / 9
/** Cells the grid drifts a loop. */
const DRIFT = 4

type Segment = { from: number; aspect: number; platform: Platform }
const seg = (from: number, aspect: number, platform: Platform = 'none'): Segment => ({
  from,
  aspect,
  platform,
})
const STATES: Record<string, Segment[]> = {
  all: [
    seg(0, WIDE),
    seg(1.2, 1),
    seg(2.4, TALL),
    seg(3.6, TALL, 'reels'),
    seg(4.8, TALL, 'shorts'),
  ],
  reels: [seg(0, WIDE, 'reels'), seg(1.5, 1, 'reels'), seg(3, TALL, 'reels')],
  shorts: [seg(0, WIDE, 'shorts'), seg(1.5, 1, 'shorts'), seg(3, TALL, 'shorts')],
}
/** shorts and tiktok are the same estimate in safeArea, so they share a name. */
const PLATFORM_LABEL: Record<Platform, string> = {
  none: 'GENERIC',
  reels: 'REELS',
  shorts: 'SHORTS',
  tiktok: 'SHORTS',
}

const ratioName = (a: number) => (a > 1.7 ? '16:9' : a < 0.6 ? '9:16' : '1:1')
const classOf = (aspect: number) =>
  1 / aspect > 4 / 3 ? 'vertical' : 1 / aspect >= 0.8 ? 'near-square' : 'landscape'

const formatSafeAreas: OpenPreview = async (host, stateId) => {
  const segments = STATES[stateId]
  if (!segments) throw new Error(`format-safe-areas has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  const frameAt = (time: number) => {
    const t = ((time % duration) + duration) % duration
    const { aspect, platform } = segments.findLast((s) => t >= s.from) as Segment
    // The frame as large as the stage allows.
    const maxH = STAGE.bottom - STAGE.top
    const w = Math.min(R - L, maxH * aspect)
    const h = w / aspect
    const fx = (width - w) / 2
    const fy = STAGE.top + (maxH - h) / 2
    return {
      t,
      aspect,
      platform,
      w,
      h,
      fx,
      fy,
      area: safeArea(w, h, platform),
      vertical: classOf(aspect) === 'vertical',
    }
  }
  type F = ReturnType<typeof frameAt>
  /** Seconds since `label(f)` last changed, looking back up to a second. */
  const sinceChange = (t: number, label: (f: F) => string) => {
    const now = label(frameAt(t))
    for (let d = 1 / 30; d <= 1; d += 1 / 30) if (label(frameAt(t - d)) !== now) return d
    return 1
  }
  const untilChange = (t: number, label: (f: F) => string) => {
    const now = label(frameAt(t))
    for (let d = 1 / 30; d <= 1; d += 1 / 30) if (label(frameAt(t + d)) !== now) return d
    return 9
  }
  const formatWord = (f: F) => ratioName(f.aspect)
  const platformWord = (f: F) =>
    f.vertical ? PLATFORM_LABEL[f.platform] : classOf(f.aspect).toUpperCase()

  // The wall through the frame's lens: grid lines every CELL.
  const drawGrid = (f: F) => {
    const { fx, fy, w, h, t } = f
    const focal = h / 2 / Math.tan(FOV / 2)
    const cx = fx + w / 2
    const cy = fy + h / 2
    const shift = ((t / duration) * DRIFT * CELL) % CELL
    ctx.fillStyle = 'rgba(255,255,255,0.2)'
    const reachX = w / 2 / focal + CELL
    for (let x = -Math.ceil(reachX / CELL) * CELL; x <= reachX; x += CELL) {
      const sx = Math.round(cx + (x + shift) * focal)
      if (sx >= fx && sx < fx + w) ctx.fillRect(sx, fy, 1, h)
    }
    const reachY = h / 2 / focal
    for (let y = -Math.floor(reachY / CELL) * CELL; y <= reachY; y += CELL) {
      const sy = Math.round(cy + y * focal)
      if (sy >= fy && sy < fy + h) ctx.fillRect(fx, sy, w, 1)
    }
  }

  const bracket = (x: number, y: number, w: number, h: number, color: string, len = 16) => {
    ctx.fillStyle = color
    const t = 2
    for (const [px, py, dx, dy] of [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
    ] as const) {
      ctx.fillRect(dx > 0 ? px : px - len, dy > 0 ? py : py - t, len, t)
      ctx.fillRect(dx > 0 ? px : px - t, dy > 0 ? py : py - len, t, len)
    }
  }

  return {
    async render(t, o) {
      const f = frameAt(t)
      const { fx, fy, w, h, area } = f
      // The rule changed class within the last 0.25 s.
      const flash = classOf(frameAt(t - 0.25).aspect) !== classOf(f.aspect)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      // The three formats, dashed.
      ctx.setLineDash([4, 8])
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'
      for (const aspect of [WIDE, 1, TALL]) {
        const maxH = STAGE.bottom - STAGE.top
        const gw = Math.min(R - L, maxH * aspect)
        const gh = gw / aspect
        ctx.strokeRect((width - gw) / 2, STAGE.top + (maxH - gh) / 2, gw, gh)
      }
      ctx.setLineDash([])
      // The frame and the grid it sees, the margins safeArea returns dimmed.
      const sx = fx + area.left
      const sy = fy + area.top
      const sw = area.width
      const sh = area.height
      ctx.save()
      ctx.beginPath()
      ctx.rect(fx, fy, w, h)
      ctx.clip()
      drawGrid(f)
      ctx.fillStyle = 'rgba(0,0,0,0.62)'
      ctx.fillRect(fx, fy, w, area.top)
      ctx.fillRect(fx, sy + sh, w, area.bottom)
      ctx.fillRect(fx, sy, area.left, sh)
      ctx.fillRect(sx + sw, sy, area.right, sh)
      ctx.restore()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1
      ctx.strokeRect(fx + 0.5, fy + 0.5, w - 1, h - 1)
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1)
      bracket(sx - 6, sy - 6, sw + 12, sh + 12, RED, flash ? 30 : 16)
      // The words hold the safe box's corners: the format, and the platform or the rule's class.
      const pad = 10
      const wordWidth = sw - 2 * pad
      house.bigWord({
        text: formatWord(f),
        corner: 'tl',
        x: sx + pad,
        y: sy + pad,
        size: 96,
        maxWidth: wordWidth * 0.8,
        since: sinceChange(t, formatWord),
        until: untilChange(t, formatWord),
        frame: o.frame,
      })
      house.bigWord({
        text: platformWord(f),
        corner: 'br',
        x: sx + sw - pad,
        y: sy + sh - pad,
        size: 96,
        maxWidth: wordWidth,
        since: sinceChange(t, platformWord),
        until: untilChange(t, platformWord),
        frame: o.frame,
      })
      // Margins, small, in the dimmed zones.
      ctx.font = `13px ${mono}`
      ctx.fillStyle = '#cfcfcf'
      const pct = (v: number, of: number) => `${Math.round((100 * v) / of)}%`
      ctx.textAlign = 'center'
      if (area.top > 18) ctx.fillText(pct(area.top, h), fx + w / 2, fy + area.top / 2 + 5)
      if (area.bottom > 18)
        ctx.fillText(pct(area.bottom, h), fx + w / 2, sy + sh + area.bottom / 2 + 5)
      if (area.right > 30) ctx.fillText(pct(area.right, w), sx + sw + area.right / 2, sy + sh / 2)
      if (area.left > 30) ctx.fillText(pct(area.left, w), fx + area.left / 2, sy + sh / 2)
      const plat = f.platform === 'none' ? '' : `, '${f.platform}'`
      house.hud(
        t,
        o.frame,
        `${classOf(f.aspect).toUpperCase()}   T ${pct(area.top, h)}  R ${pct(area.right, w)}  B ${pct(area.bottom, h)}  L ${pct(area.left, w)}`,
        `safeArea(${ratioName(f.aspect)}${plat})`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const f = frameAt(t)
      return f.vertical && f.platform !== 'none'
        ? `${ratioName(f.aspect)} ${f.platform}`
        : ratioName(f.aspect)
    },
    inspect(t) {
      const f = frameAt(t)
      return {
        id: 'frame',
        aspect: f.aspect,
        platform: f.platform,
        margins: { left: f.area.left, right: f.area.right, top: f.area.top, bottom: f.area.bottom },
      }
    },
  }
}

export default formatSafeAreas
