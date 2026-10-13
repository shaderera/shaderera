// camera-shake: a 120 mm shot of the city's monolith (previews/src/city.ts), drifting slowly
// round it, shaken by the item. 'all' gives each preset two seconds: breathe (a tripod that is
// still alive), handheld, then impact, kicking on three hits while the city jumps with them. The
// other states hold one preset for the loop. A dashed crosshair marks where the shot is aimed and
// a red tracking box where the aim is now, trailing its last second; the yaw, pitch and roll scroll
// past on one scale for every preset, so the gentlest and the hardest can be compared. The preset
// and its size are the big words (house.ts).

import { createCity, project } from '../../previews/src/city.ts'
import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import {
  blendShots,
  fit,
  lens,
  type Shot,
  viewProjection,
} from '../../previews/src/motion/camera.ts'
import { hits, SHAKE, type ShakeStyle, shake } from '../../previews/src/motion/shake.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const L = 48
const R = 1032
const LIFT: readonly [number, number] = [0, 0.082]
/** A long lens: the shake reads in pixels, as it does on a real telephoto. */
const MM = 120
/** The scale of the traces: ±2° fills the lane. */
const SCALE = 2
/** The trace's window: the last 3 s. */
const WINDOW = 3

type Preset = 'breathe' | 'handheld' | 'impact'
const STYLE: Record<Preset, ShakeStyle> = {
  breathe: SHAKE.breathe,
  handheld: SHAKE.handheld,
  impact: SHAKE.impact,
}
const NOTES: Record<Preset, string> = {
  breathe: 'a tripod that is still alive, never quite still',
  handheld: 'a camera held in two hands, the same every render',
  impact: 'kicks on every hit, then settles',
}
/** Where each preset is on in 'all', with a short crossfade between them. */
const SEGMENTS: { id: Preset; from: number; to: number }[] = [
  { id: 'breathe', from: 0, to: 2 },
  { id: 'handheld', from: 2, to: 4 },
  { id: 'impact', from: 4, to: 6 },
]
const HITS: Record<string, number[]> = {
  all: [4.12, 4.87, 5.25],
  impact: [0.12, 0.87, 1.25, 2.12, 3.12, 3.87, 4.25, 5.12],
}
const FADE = 0.2
/** The last stretch of the loop crossfades into its start, since the noise never repeats. */
const SEAM = 0.6

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

const cameraShake: OpenPreview = async (host, stateId) => {
  if (!['all', 'breathe', 'handheld', 'impact'].includes(stateId))
    throw new Error(`camera-shake has no state "${stateId}"`)
  const device = host.gpu
  if (!device) throw new Error('The camera-shake preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const aspect = width / height
  const city = createCity(device, width, height)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`
  const loop = (t: number) => ((t % duration) + duration) % duration

  /** The authored shot: a slow drift round the monolith, once out and back a loop. */
  const baseAt = (t: number): Shot => {
    const ph = loop(t) / duration
    return fit({
      center: [0, 2.3, 0],
      radius: 2.2,
      azimuth: 210 + 10 * Math.sin(ph * Math.PI * 2),
      elevation: 14 + 2 * Math.sin(ph * Math.PI * 4),
      fov: lens(MM, 1),
      aspect: 1,
      fill: 0.6 + 0.06 * Math.cos(ph * Math.PI * 2),
      shift: LIFT,
    })
  }
  const hitTimes = (HITS[stateId] ?? []).flatMap((h) => [h - duration, h, h + duration])

  /** How much of each preset is on at a time of the loop. */
  const amounts = (t: number): Record<Preset, number> => {
    if (stateId !== 'all')
      return {
        breathe: stateId === 'breathe' ? 1 : 0,
        handheld: stateId === 'handheld' ? 1 : 0,
        impact: stateId === 'impact' ? 1 : 0,
      }
    const x = loop(t)
    const handheld = smooth((x - 2 + FADE / 2) / FADE) * (1 - smooth((x - 4 + FADE / 2) / FADE))
    // Impact takes over at 4 s and hands back to breathe before the loop ends.
    const impact = smooth((x - 4 + FADE / 2) / FADE) * (1 - smooth((x - 5.65) / 0.3))
    return { breathe: Math.max(0, 1 - handheld - impact), handheld, impact }
  }
  const kick = (t: number) => hits(loop(t), hitTimes, 0.22)

  /** The shot shaken with the noise at t (which never repeats). */
  const shaken = (t: number): Shot => {
    const a = amounts(t)
    let c = baseAt(t)
    if (a.breathe > 0) c = shake(c, t, STYLE.breathe, a.breathe, 3)
    if (a.handheld > 0) c = shake(c, t, STYLE.handheld, a.handheld, 5)
    if (a.impact > 0) c = shake(c, t, STYLE.impact, a.impact * kick(t), 7)
    return c
  }
  const at = (t: number): Shot => {
    const x = loop(t)
    const w = smooth((x - (duration - SEAM)) / SEAM)
    return w > 0 ? blendShots(shaken(x), shaken(x - duration), w) : shaken(x)
  }

  /** The aim's yaw, pitch and roll against the authored shot, in degrees. */
  const angles = (c: Shot, base: Shot) => {
    const unit = (s: Shot) => {
      const d = s.target.map((v, i) => v - (s.eye[i] ?? 0))
      const n = Math.hypot(...d)
      return d.map((v) => v / n) as [number, number, number]
    }
    const b = unit(base)
    const dir = unit(c)
    const n = Math.hypot(b[0], b[2])
    const right = [-b[2] / n, 0, b[0] / n]
    const dot = dir[0] * (right[0] ?? 0) + dir[2] * (right[2] ?? 0)
    const deg = 180 / Math.PI
    return {
      yaw: Math.asin(Math.max(-1, Math.min(1, dot))) * deg,
      pitch: (dir[1] - b[1]) * deg,
      roll: (c.roll - base.roll) * deg,
    }
  }
  const anglesAt = (t: number) => angles(at(t), baseAt(t))

  const state = (t: number) => {
    const a = amounts(t)
    const preset =
      stateId === 'all'
        ? (SEGMENTS.find((s) => loop(t) >= s.from && loop(t) < s.to)?.id ?? 'breathe')
        : (stateId as Preset)
    const c = at(t)
    const base = baseAt(t)
    return { a, preset, c, base, angles: angles(c, base), kick: a.impact * kick(t) }
  }

  const crosshair = (x: number, y: number, size: number, gap: number) => {
    ctx.beginPath()
    ctx.moveTo(x - size, y)
    ctx.lineTo(x - gap, y)
    ctx.moveTo(x + gap, y)
    ctx.lineTo(x + size, y)
    ctx.moveTo(x, y - size)
    ctx.lineTo(x, y - gap)
    ctx.moveTo(x, y + gap)
    ctx.lineTo(x, y + size)
    ctx.stroke()
  }

  const drawAim = (t: number, s: ReturnType<typeof state>) => {
    const aim = project(viewProjection(s.base, aspect), s.base.target, width, height)
    if (!aim) return
    // Where the authored aim lands through the shaken camera, now and over the last second.
    const where = (time: number) => {
      const b = baseAt(time)
      return project(viewProjection(at(time), aspect), b.target, width, height)
    }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const trail: { x: number; y: number }[] = []
    for (let i = 30; i >= 0; i--) {
      const p = where(t - i / 30)
      // The trail is drawn against today's aim, so the drift of the shot itself is taken out.
      const b = project(
        viewProjection(baseAt(t - i / 30), aspect),
        baseAt(t - i / 30).target,
        width,
        height,
      )
      if (p && b) trail.push({ x: aim.x + p.x - b.x, y: aim.y + p.y - b.y })
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]
      const b = trail[i]
      if (!a || !b) continue
      ctx.globalAlpha = (i / trail.length) ** 1.5
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    crosshair(aim.x, aim.y, 40, 10)
    ctx.setLineDash([])
    const now = trail[trail.length - 1]
    if (now) {
      // The live aim: a red tracking box with its offset.
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      ctx.strokeRect(now.x - 16, now.y - 16, 32, 32)
      ctx.fillStyle = RED
      ctx.fillRect(now.x - 2, now.y - 2, 4, 4)
      const off = Math.hypot(now.x - aim.x, now.y - aim.y)
      ctx.font = `14px ${mono}`
      ctx.textAlign = 'left'
      const label = `AIM +${off.toFixed(0)} PX`
      ctx.fillRect(now.x + 16, now.y - 16, ctx.measureText(label).width + 10, 18)
      ctx.fillStyle = '#000'
      ctx.fillText(label, now.x + 21, now.y - 3)
    }
  }

  // The yaw, pitch and roll of the last three seconds, scrolling, on one scale for every preset.
  const drawTraces = (t: number, s: ReturnType<typeof state>) => {
    const top = 650
    const h = 110
    const mid = top + h / 2
    const xOf = (time: number) => R - ((t - time) / WINDOW) * (R - L)
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    for (const d of [-1, 1]) ctx.fillRect(L, mid - (d / SCALE) * (h / 2), R - L, 1)
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(L, top, R - L, 1)
    ctx.fillRect(L, top + h, R - L, 1)
    ctx.fillRect(L, mid, R - L, 1)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(`+${SCALE}°`, L + 4, top + 15)
    ctx.fillText(`-${SCALE}°`, L + 4, top + h - 5)
    // Preset names where each began, scrolling with the traces.
    if (stateId === 'all')
      for (const k of [-1, 0])
        for (const seg of SEGMENTS) {
          const x = xOf(seg.from + k * duration)
          if (x < L - 200 || x > R) continue
          ctx.fillStyle = 'rgba(255,255,255,0.3)'
          ctx.fillRect(x, top - 22, 1, h + 22)
          ctx.fillStyle = seg.id === s.preset ? '#fff' : '#7a7a7a'
          ctx.fillText(seg.id.toUpperCase(), Math.max(L, x + 6), top - 8)
        }
    const samples = 240
    const pts = Array.from({ length: samples + 1 }, (_, i) => {
      const time = t - WINDOW + (i / samples) * WINDOW
      return { x: xOf(time), ...anglesAt(time) }
    })
    const line = (key: 'yaw' | 'pitch' | 'roll', color: string, w: number) => {
      ctx.strokeStyle = color
      ctx.lineWidth = w
      ctx.beginPath()
      pts.forEach((p, i) => {
        const y = mid - (Math.max(-SCALE, Math.min(SCALE, p[key])) / SCALE) * (h / 2)
        if (i === 0) ctx.moveTo(p.x, y)
        else ctx.lineTo(p.x, y)
      })
      ctx.stroke()
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(L, top - 2, R - L, h + 4)
    ctx.clip()
    line('roll', 'rgba(255,255,255,0.3)', 1.2)
    line('pitch', 'rgba(255,255,255,0.6)', 1.5)
    line('yaw', '#fff', 2)
    ctx.restore()
    // The hits, where they fall: red markers.
    for (const hit of hitTimes) {
      const x = xOf(hit)
      if (x < L || x > R) continue
      ctx.fillStyle = RED
      ctx.beginPath()
      ctx.moveTo(x - 6, top + h + 14)
      ctx.lineTo(x + 6, top + h + 14)
      ctx.lineTo(x, top + h + 3)
      ctx.fill()
    }
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#9a9a9a'
    ctx.fillText(
      `YAW ${s.angles.yaw.toFixed(2)}°   PITCH ${s.angles.pitch.toFixed(2)}°   ROLL ${s.angles.roll.toFixed(2)}°`,
      L + 60,
      top + h + 30,
    )
  }

  const words: Word[] =
    stateId === 'all'
      ? SEGMENTS.map((s) => ({ from: s.from, to: s.to, text: s.id.toUpperCase() }))
      : [{ from: 0, to: duration, text: stateId.toUpperCase() }]
  const sizes: Word[] =
    stateId === 'all'
      ? SEGMENTS.map((s) => ({
          from: s.from,
          to: s.to,
          text: `${STYLE[s.id].degrees.toFixed(2)}°`,
        }))
      : [{ from: 0, to: duration, text: `${STYLE[stateId as Preset].degrees.toFixed(2)}°` }]

  return {
    async render(t, o) {
      const s = state(t)
      const vp = viewProjection(s.c, aspect)
      const frame = city.render(vp, s.c.eye, { phase: t / duration, kick: s.kick, fog: 0.028 })
      ctx.clearRect(0, 0, width, height)
      theme.wash(width)
      theme.index()
      // Canvas state (line caps, dashes) must not carry from one frame to the next.
      ctx.save()
      drawAim(t, s)
      ctx.restore()
      drawTraces(t, s)
      // Impact words glitch on every hit.
      theme.words(words, sizes, t, s.kick > 0.5 ? o.frame + 1000 : o.frame)
      const style = STYLE[s.preset]
      theme.note(`${NOTES[s.preset]}, ${style.frequency.toFixed(2)} Hz`, R, 800)
      theme.hud(
        t,
        o.frame,
        `${MM} MM   HIT ${s.kick.toFixed(2)}`,
        `SHAKE.${s.preset.toUpperCase()}`,
      )
      // A hit flashes the frame.
      if (s.kick > 0.95) {
        ctx.fillStyle = `rgba(255,255,255,${0.18 * Math.min(1, s.kick) ** 4})`
        ctx.fillRect(0, 0, width, 904)
      }
      return [
        { color: frame, alpha: 'opaque', name: 'city' },
        { color: canvas, name: 'overlay' },
      ]
    },
    status(t) {
      const s = state(t)
      return stateId === 'all'
        ? `${String(SEGMENTS.findIndex((x) => x.id === s.preset) + 1).padStart(2, '0')}/03  ${s.preset}`
        : s.preset
    },
    inspect(t) {
      const s = state(t)
      return {
        id: 'shake',
        preset: s.preset,
        amounts: s.a,
        hit: s.kick,
        yaw: s.angles.yaw,
        pitch: s.angles.pitch,
        roll: s.angles.roll,
        eye: [...s.c.eye],
        target: [...s.c.target],
      }
    },
  }
}

export default cameraShake
