// format-safe-areas: one shot relaid for 16:9, 1:1 and 9:16. The frame morphs between formats
// while the item answers for every in-between: safeArea gives the box text may use (thin white
// lines, the margins dimmed, red brackets on its corners that flash where its rule changes class),
// the two big words hold its corners, and the luminous point field behind is seen through
// widenFov's lens, so a skyline that spans 16:9 still reads in 9:16. In 'all' the vertical frame
// then takes each platform's zone; a state holds one platform.

import { AREA, createHouse, RED } from '../../previews/src/house.ts'
import { type Platform, safeArea, widenFov } from '../../previews/src/layout/frame.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = AREA.left
const R = AREA.right
/** The stage the frame morphs in. */
const STAGE = { top: 120, bottom: 850 }
const FOV = (40 * Math.PI) / 180
const WIDE = 16 / 9
const TALL = 9 / 16
const TAU = Math.PI * 2

type Key = { at: number; aspect: number; platform: Platform }
const k = (at: number, aspect: number, platform: Platform = 'none'): Key => ({
  at,
  aspect,
  platform,
})
const STATES: Record<string, Key[]> = {
  all: [
    k(0, WIDE),
    k(0.55, WIDE),
    k(1.05, 1),
    k(1.6, 1),
    k(2.15, TALL),
    k(2.75, TALL),
    k(3.0, TALL, 'reels'),
    k(3.85, TALL, 'reels'),
    k(4.1, TALL, 'shorts'),
    k(5.25, TALL, 'shorts'),
    k(5.85, WIDE),
    k(6, WIDE),
  ],
  reels: [
    k(0, WIDE, 'reels'),
    k(0.7, WIDE, 'reels'),
    k(1.5, TALL, 'reels'),
    k(4.7, TALL, 'reels'),
    k(5.5, WIDE, 'reels'),
    k(6, WIDE, 'reels'),
  ],
  shorts: [
    k(0, WIDE, 'shorts'),
    k(0.7, WIDE, 'shorts'),
    k(1.5, TALL, 'shorts'),
    k(4.7, TALL, 'shorts'),
    k(5.5, WIDE, 'shorts'),
    k(6, WIDE, 'shorts'),
  ],
}
/** shorts and tiktok are the same estimate in safeArea, so they share a name. */
const PLATFORM_LABEL: Record<Platform, string> = {
  none: 'GENERIC',
  reels: 'REELS',
  shorts: 'SHORTS',
  tiktok: 'SHORTS',
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)
const lerp = (a: number, b: number, x: number) => a + (b - a) * x
const ratioName = (a: number) =>
  Math.abs(a - WIDE) < 0.01
    ? '16:9'
    : Math.abs(a - 1) < 0.01
      ? '1:1'
      : Math.abs(a - TALL) < 0.01
        ? '9:16'
        : `${a.toFixed(2)}:1`
const classOf = (aspect: number) =>
  1 / aspect > 4 / 3 ? 'vertical' : 1 / aspect >= 0.8 ? 'near-square' : 'landscape'

const formatSafeAreas: OpenPreview = async (host, stateId) => {
  const keys = STATES[stateId]
  if (!keys) throw new Error(`format-safe-areas has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  const frameAt = (time: number) => {
    const t = ((time % duration) + duration) % duration
    let i = 0
    while (i < keys.length - 2 && t >= (keys[i + 1] as Key).at) i++
    const a = keys[i] as Key
    const b = keys[i + 1] as Key
    const x = ease(Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at || 1))))
    const aspect = Math.exp(lerp(Math.log(a.aspect), Math.log(b.aspect), x))
    // The frame as large as the stage allows.
    const maxW = R - L
    const maxH = STAGE.bottom - STAGE.top
    const w = Math.min(maxW, maxH * aspect)
    const h = w / aspect
    const fx = (width - w) / 2
    const fy = STAGE.top + (maxH - h) / 2
    // The margins at this aspect, blended across a change of platform.
    const pa = safeArea(w, h, a.platform)
    const pb = safeArea(w, h, b.platform)
    const m = a.platform === b.platform ? 0 : x
    const area = {
      left: lerp(pa.left, pb.left, m),
      right: lerp(pa.right, pb.right, m),
      top: lerp(pa.top, pb.top, m),
      bottom: lerp(pa.bottom, pb.bottom, m),
    }
    const platform = m < 0.5 ? a.platform : b.platform
    // When the label last changed, for the words to scramble in.
    const vertical = classOf(aspect) === 'vertical'
    return { t, aspect, w, h, fx, fy, area, platform, vertical, fov: widenFov(FOV, aspect) }
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
  const formatWord = (f: F) =>
    f.aspect > 1.7
      ? '16:9'
      : f.aspect < 0.6
        ? '9:16'
        : f.aspect > 0.9 && f.aspect < 1.1
          ? '1:1'
          : ''
  const platformWord = (f: F) =>
    f.vertical ? PLATFORM_LABEL[f.platform] : classOf(f.aspect).toUpperCase()

  // The luminous field: a rolling terrain of points, and a skyline of point columns as wide as a
  // 16:9 shot, every motion a whole number of cycles a loop.
  const drawScene = (f: F) => {
    const { fx, fy, w, h, fov, t } = f
    const ph = (t / duration) * TAU
    const focal = h / 2 / Math.tan(fov / 2)
    const cx = fx + w / 2 + Math.sin(ph) * w * 0.03
    const cy = fy + h * 0.5
    const camY = 1.25 + 0.15 * Math.sin(ph * 2)
    const pitch = -0.06
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    ctx.globalCompositeOperation = 'lighter'
    const dot = (x: number, y: number, z: number, a: number, rgb = '255,255,255', size = 1) => {
      const yy = y - camY
      const y2 = yy * cp - z * sp
      const z2 = yy * sp + z * cp
      if (z2 > -0.2) return
      const sx = cx + (x / -z2) * focal
      const sy = cy - (y2 / -z2) * focal
      if (sx < fx - 4 || sx > fx + w + 4 || sy < fy - 4 || sy > fy + h + 4) return
      const s = size * (0.9 + 9 / -z2)
      ctx.fillStyle = `rgba(${rgb},${a})`
      ctx.fillRect(sx - s / 2, sy - s / 2, s, s)
    }
    // Rows spaced geometrically and points closer together near the camera, so the field is
    // equally dense on screen from the foot of the frame to the horizon.
    for (let zi = 0; zi < 64; zi++) {
      const z = -1.1 * 1.058 ** zi
      const depth = Math.min(1, (-z - 1) / 36)
      const step = 0.05 * (-z) ** 0.75
      const reach = Math.min(14, 1.5 - z * 1.3)
      const a = 0.85 * (1 - depth) ** 1.2 + 0.12
      const rgb = depth > 0.45 ? '205,190,255' : '255,255,255'
      for (let x = -reach; x <= reach; x += step) {
        const y =
          0.42 * Math.sin(0.5 * x + 2 * ph) * Math.cos(0.33 * z - 3 * ph) +
          0.22 * Math.sin(0.8 * x - 0.6 * z + 4 * ph)
        dot(x, y - 0.4, z, a, rgb, 1)
      }
    }
    const bars = 25
    for (let i = 0; i < bars; i++) {
      const x = -6 + (12 * i) / (bars - 1)
      const hgt =
        1.4 +
        3.2 * (0.5 + 0.5 * Math.sin(ph * 2 + i * 0.7)) * (0.5 + 0.5 * Math.cos(ph * 3 - i * 0.31))
      for (let y = 0; y < hgt; y += 0.1)
        for (const dx of [-0.12, 0, 0.12])
          dot(x + dx, y - 0.4, -10, 0.9, i === 12 ? '255,205,170' : '255,255,255', 0.9)
    }
    ctx.globalCompositeOperation = 'source-over'
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
      // The three formats, dashed, for the frame to morph between.
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
      // The frame and what it sees, the margins dimmed.
      const sx = fx + area.left
      const sy = fy + area.top
      const sw = w - area.left - area.right
      const sh = h - area.top - area.bottom
      ctx.save()
      ctx.beginPath()
      ctx.rect(fx, fy, w, h)
      ctx.clip()
      drawScene(f)
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
        text: formatWord(f) || ratioName(f.aspect),
        corner: 'tl',
        x: sx + pad,
        y: sy + pad,
        size: 96,
        maxWidth: wordWidth * 0.8,
        since: formatWord(f) ? sinceChange(t, formatWord) : 0,
        until: formatWord(f) ? untilChange(t, formatWord) : 9,
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
      // A note over the frame: the lens.
      house.note(
        flash
          ? 'the rule changes class here'
          : `the lens opens to ${((f.fov * 180) / Math.PI).toFixed(1)}°, and the skyline still reads`,
        fx + w,
        fy - 12,
        'right',
        24,
        flash ? RED : '#d8d8d8',
      )
      const plat = f.platform === 'none' ? '' : `, '${f.platform}'`
      house.hud(
        t,
        o.frame,
        `${classOf(f.aspect).toUpperCase()}   T ${pct(area.top, h)}  R ${pct(area.right, w)}  B ${pct(area.bottom, h)}  L ${pct(area.left, w)}`,
        `safeArea(${ratioName(f.aspect)}${plat})   widenFov 40° → ${((f.fov * 180) / Math.PI).toFixed(1)}°`,
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
        margins: { ...f.area },
        fov: (f.fov * 180) / Math.PI,
      }
    },
  }
}

export default formatSafeAreas
