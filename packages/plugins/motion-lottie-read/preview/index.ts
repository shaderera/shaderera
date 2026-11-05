// motion-lottie-read: a Lottie file made in code (preview/lottie.ts), read by the plugin through
// the host's files, as a film would. On the stage a card is drawn from nothing but `valueAt` on
// its layer's transform: position along the file's curved path (drawn with its tangents), scale,
// rotation and opacity, with onion skins a frame apart. Below, the value graph of one property at
// a time, as written: the curve, the keys as red diamonds, each move's bezier handles as the file
// stores them, and a flat run where a key holds. The list of what was not read is the note.

import type { Host } from '@shaderera/core'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import {
  type LottieKey,
  type LottieProperty,
  loadLottie,
  valueAt,
} from '../../previews/src/motion/lottie.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { makeLottie } from './lottie.ts'

/** Where the file's 900 × 420 frame sits, and the graph under it. */
const STAGE = { x: 90, y: 150 }
const GRAPH = { top: 640, bottom: 760 }
const FOCUS = [
  { name: 'p', word: 'POSITION' },
  { name: 's', word: 'SCALE' },
  { name: 'r', word: 'ROTATION' },
  { name: 'o', word: 'OPACITY' },
] as const

const motionLottieRead: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`motion-lottie-read has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const fps = Number(host.manifest.fps)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The file's text as a project file, read back by the plugin.
  const text = new TextEncoder().encode(makeLottie())
  const reader = {
    ...host,
    io: {
      ...host.io,
      read: async (path: string) => {
        if (path !== 'assets/card.json') throw new Error(`No file ${path}`)
        return text
      },
    },
  } as Host
  const lottie = await loadLottie(reader, 'assets/card.json')
  const card = lottie.layers[0]?.transform ?? {}
  const prop = (name: string) => card[name] as LottieProperty
  const each = duration / FOCUS.length
  const loop = (t: number) => ((t % lottie.out) + lottie.out) % lottie.out
  const focusAt = (t: number) => FOCUS[Math.min(FOCUS.length - 1, Math.floor(t / each))] ?? FOCUS[0]

  const pose = (t: number) => {
    const u = loop(t)
    const [x = 0, y = 0] = valueAt(prop('p'), u)
    const [sx = 100, sy = 100] = valueAt(prop('s'), u)
    return { x, y, sx, sy, r: valueAt(prop('r'), u)[0] ?? 0, o: valueAt(prop('o'), u)[0] ?? 100 }
  }

  const drawCard = (p: ReturnType<typeof pose>, alpha: number, filled: boolean) => {
    ctx.save()
    ctx.translate(STAGE.x + p.x, STAGE.y + p.y)
    ctx.rotate((p.r * Math.PI) / 180)
    ctx.scale(p.sx / 100, p.sy / 100)
    ctx.globalAlpha = alpha * (p.o / 100)
    if (filled) {
      ctx.fillStyle = '#4a4a4a'
      ctx.fillRect(-60, -40, 120, 80)
    }
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2 / Math.max(0.3, Math.min(p.sx, p.sy) / 100)
    ctx.strokeRect(-60, -40, 120, 80)
    ctx.restore()
  }

  /** The position's path as the file writes it: each move a cubic with its tangents. */
  const drawPath = () => {
    const keys = prop('p').keys
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i] as LottieKey
      const b = keys[i + 1] as LottieKey
      const [ax = 0, ay = 0] = a.value ?? []
      const [bx = 0, by = 0] = b.value ?? []
      const c1 = [ax + (a.pathOut?.[0] ?? 0), ay + (a.pathOut?.[1] ?? 0)] as const
      const c2 = [bx + (a.pathIn?.[0] ?? 0), by + (a.pathIn?.[1] ?? 0)] as const
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(STAGE.x + ax, STAGE.y + ay)
      ctx.bezierCurveTo(
        STAGE.x + c1[0],
        STAGE.y + c1[1],
        STAGE.x + c2[0],
        STAGE.y + c2[1],
        STAGE.x + bx,
        STAGE.y + by,
      )
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,59,31,0.5)'
      ctx.lineWidth = 1
      for (const [k, c] of [
        [[ax, ay], c1],
        [[bx, by], c2],
      ] as const) {
        ctx.beginPath()
        ctx.moveTo(STAGE.x + k[0], STAGE.y + k[1])
        ctx.lineTo(STAGE.x + c[0], STAGE.y + c[1])
        ctx.stroke()
        ctx.fillStyle = RED
        ctx.fillRect(STAGE.x + c[0] - 2.5, STAGE.y + c[1] - 2.5, 5, 5)
      }
    }
    // Where the card is on every frame of the file: the spacing the eases give.
    for (let f = lottie.ip; f < lottie.op; f++) {
      const [x = 0, y = 0] = valueAt(prop('p'), f / lottie.fr)
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.fillRect(STAGE.x + x - 1, STAGE.y + y - 1, 2, 2)
    }
  }

  /** One property's value graph: every dimension, the keys, and the handles as written. */
  const drawGraph = (t: number, p: LottieProperty) => {
    const { top, bottom } = GRAPH
    const dims = p.name === 's' ? 2 : p.name === 'p' ? 2 : 1
    const samples = Array.from({ length: 601 }, (_, i) => valueAt(p, (i / 600) * lottie.out))
    const all = samples.flatMap((v) => v.slice(0, dims))
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    const xOf = (s: number) => L + (s / lottie.out) * (R - L)
    const yOf = (v: number) => bottom - ((v - lo) / Math.max(1e-6, hi - lo)) * (bottom - top)
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    for (let i = 0; i <= 2; i++) ctx.fillRect(L, top + ((bottom - top) * i) / 2, R - L, 1)
    for (let d = 0; d < dims; d++) {
      ctx.strokeStyle = d === 0 ? '#fff' : 'rgba(255,255,255,0.45)'
      ctx.lineWidth = d === 0 ? 2 : 1.5
      ctx.beginPath()
      samples.forEach((v, i) => {
        const x = xOf((i / 600) * lottie.out)
        const y = yOf(v[d] ?? 0)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
    // Each move's handles, the bezier's two points in the move's box (dimension 0). A path's
    // handles ease the distance along it, not a value, so its tangents are drawn on the stage.
    const spatial = p.keys.some((k) => k.pathOut || k.pathIn)
    for (let i = 0; i < p.keys.length - 1 && !spatial; i++) {
      const a = p.keys[i] as LottieKey
      const b = p.keys[i + 1] as LottieKey
      if (a.hold || !a.out || !a.in) continue
      const v0 = valueAt(p, a.t)[0] ?? 0
      const v1 = valueAt(p, b.t)[0] ?? 0
      const pt = (hx: number, hy: number) =>
        [xOf(a.t + hx * (b.t - a.t)), yOf(v0 + hy * (v1 - v0))] as const
      const o = pt(a.out.x[0] ?? 0, a.out.y[0] ?? 0)
      const n = pt(a.in.x[0] ?? 0, a.in.y[0] ?? 0)
      ctx.strokeStyle = 'rgba(255,59,31,0.6)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(xOf(a.t), yOf(v0))
      ctx.lineTo(o[0], o[1])
      ctx.moveTo(xOf(b.t), yOf(v1))
      ctx.lineTo(n[0], n[1])
      ctx.stroke()
      ctx.fillStyle = RED
      for (const [hx, hy] of [o, n]) {
        ctx.beginPath()
        ctx.arc(hx, hy, 3.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    for (const k of p.keys) {
      const kx = xOf(k.t)
      const ky = yOf(valueAt(p, k.t)[0] ?? 0)
      ctx.fillStyle = k.t <= loop(t) ? RED : '#000'
      ctx.strokeStyle = RED
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(kx, ky - 7)
      ctx.lineTo(kx + 7, ky)
      ctx.lineTo(kx, ky + 7)
      ctx.lineTo(kx - 7, ky)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      if (k.hold) {
        ctx.font = `12px ${mono}`
        ctx.textAlign = 'left'
        ctx.fillStyle = '#fff'
        ctx.fillText('HOLD', kx + 10, ky - 10)
      }
    }
    const px = xOf(loop(t))
    ctx.fillStyle = '#fff'
    ctx.fillRect(px - 0.5, top - 16, 1.5, bottom - top + 24)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(`${p.path}   ${p.label}`.toUpperCase(), L, top - 22)
  }

  /** The key the focused property moves out of at t, or rests on. */
  const keyAt = (p: LottieProperty, t: number) => {
    const u = loop(t)
    let i = 0
    while (i < p.keys.length - 1 && (p.keys[i + 1] as LottieKey).t <= u) i++
    return i
  }

  const tops: Word[] = FOCUS.map((f, i) => ({ from: i * each, to: (i + 1) * each, text: f.word }))
  const bottoms: Word[] = FOCUS.map((f, i) => ({
    from: i * each,
    to: (i + 1) * each,
    text: `${prop(f.name).keys.length} KEYS`,
  }))
  const missing = [...new Set(lottie.unsupported.map((u) => u.feature))].join(', ')

  return {
    async render(t, o) {
      const focus = focusAt(t)
      const p = prop(focus.name)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.strokeRect(STAGE.x, STAGE.y, lottie.width, lottie.height)
      drawPath()
      for (let k = 6; k >= 1; k--) drawCard(pose(t - k / fps), 0.5 * (1 - k / 7), false)
      const now = pose(t)
      drawCard(now, 1, true)
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      ctx.strokeRect(STAGE.x + now.x - 8, STAGE.y + now.y - 8, 16, 16)
      drawGraph(t, p)
      house.words(tops, bottoms, t, o.frame)
      house.note(`not read, and listed: ${missing}`, R, 800)
      const v = valueAt(p, loop(t))
      house.hud(
        t,
        o.frame,
        `${focus.name.toUpperCase()} ${v.map((x) => x.toFixed(1)).join(' ')}`,
        `KEY ${keyAt(p, t) + 1}/${p.keys.length}   F ${(loop(t) * lottie.fr).toFixed(0)}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const p = prop(focusAt(t).name)
      return `${p.path}  key ${keyAt(p, t) + 1}/${p.keys.length}`
    },
    inspect(t) {
      const p = prop(focusAt(t).name)
      return {
        id: 'card',
        property: p.path,
        key: keyAt(p, t),
        value: valueAt(p, loop(t)),
        unsupported: lottie.unsupported.map((u) => `${u.feature} at ${u.where}`),
      }
    },
  }
}

export default motionLottieRead
