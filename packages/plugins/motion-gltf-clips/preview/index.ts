// motion-gltf-clips: a glTF file made in code (preview/clips.ts), read by the plugin through the
// host's files, as a film would. On the stage each animated node is a square drawn from nothing
// but `valueAt` on its channels: translation in x and y, rotation about z, with every frame of
// the clip as a faint dot. Below, the value graph of one channel at a time: each value's numbers
// over the clip, the keys as red diamonds, and a CUBICSPLINE key's in and out tangents as the file
// stores them. The note says what is present and not applied.

import type { Host } from '@shaderera/core'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { type GltfChannel, loadClips, valueAt } from '../../previews/src/motion/gltf-clips.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { makeClips } from './clips.ts'

/** The stage's origin and its pixels a model unit (y up), and the graph under it. */
const ORIGIN = { x: 540, y: 400 }
const UNIT = 100
const GRAPH = { top: 640, bottom: 760 }

const motionGltfClips: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`motion-gltf-clips has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The file's text as a project file, read back by the plugin.
  const text = new TextEncoder().encode(makeClips())
  const reader = {
    ...host,
    io: {
      ...host.io,
      read: async (path: string) => {
        if (path !== 'assets/clips.gltf') throw new Error(`No file ${path}`)
        return text
      },
    },
  } as Host
  const { clips, skins, morphTargets } = await loadClips(reader, 'assets/clips.gltf')
  const clip = clips[0]
  if (!clip) throw new Error('motion-gltf-clips preview: the file has no clip')
  const channels = clip.channels
  const each = duration / channels.length
  const loop = (t: number) => clip.start + (((t % clip.end) + clip.end) % clip.end)
  const focusAt = (t: number) =>
    channels[Math.min(channels.length - 1, Math.floor(t / each))] as GltfChannel
  const nodes = [...new Set(channels.map((c) => c.node))]
  const channelOf = (node: number, path: string) =>
    channels.find((c) => c.node === node && c.path === path)

  /** A node at t: where it is and how far it is turned about z, from its channels alone. */
  const pose = (node: number, t: number) => {
    const p = channelOf(node, 'translation')
    const r = channelOf(node, 'rotation')
    const [x = 0, y = 0] = p ? valueAt(p, t) : []
    const [, , z = 0, w = 1] = r ? valueAt(r, t) : []
    return { x: ORIGIN.x + x * UNIT, y: ORIGIN.y - y * UNIT, angle: 2 * Math.atan2(z, w) }
  }

  const drawNode = (node: number, t: number, focused: boolean) => {
    for (let f = 0; f <= 180; f++) {
      const { x, y } = pose(node, clip.start + ((clip.end - clip.start) * f) / 180)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(x - 1, y - 1, 2, 2)
    }
    const { x, y, angle } = pose(node, t)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(-angle)
    ctx.fillStyle = '#4a4a4a'
    ctx.fillRect(-36, -36, 72, 72)
    ctx.strokeStyle = focused ? RED : '#fff'
    ctx.lineWidth = 2
    ctx.strokeRect(-36, -36, 72, 72)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(36, 0)
    ctx.stroke()
    ctx.restore()
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'center'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(channelOf(node, 'translation')?.nodeName ?? `node ${node}`, x, y + 62)
  }

  /** One channel's value graph: every number of the value, the keys, and cubic tangents. */
  const drawGraph = (t: number, ch: GltfChannel) => {
    const { top, bottom } = GRAPH
    const samples = Array.from({ length: 601 }, (_, i) =>
      valueAt(ch, clip.start + ((clip.end - clip.start) * i) / 600),
    )
    const keyValues = Array.from(ch.input, (k) => valueAt(ch, k))
    const all = [...samples.flat(), ...keyValues.flat()]
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    const xOf = (s: number) => L + ((s - clip.start) / (clip.end - clip.start)) * (R - L)
    const yOf = (v: number) => bottom - ((v - lo) / Math.max(1e-6, hi - lo)) * (bottom - top)
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    for (let i = 0; i <= 2; i++) ctx.fillRect(L, top + ((bottom - top) * i) / 2, R - L, 1)
    const dims = ch.path === 'translation' ? 2 : ch.width
    for (let d = 0; d < dims; d++) {
      ctx.strokeStyle = d === 0 ? '#fff' : 'rgba(255,255,255,0.45)'
      ctx.lineWidth = d === 0 ? 2 : 1.5
      ctx.beginPath()
      samples.forEach((v, i) => {
        const x = xOf(clip.start + ((clip.end - clip.start) * i) / 600)
        const y = yOf(v[d] ?? 0)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
    for (const [k, time] of Array.from(ch.input).entries()) {
      const kx = xOf(time)
      for (let d = 0; d < dims; d++) {
        const v = keyValues[k]?.[d] ?? 0
        const ky = yOf(v)
        // A CUBICSPLINE key's tangents, a third of the way to each neighbour, as slopes in seconds.
        if (ch.interpolation === 'CUBICSPLINE') {
          const o = k * 3 * ch.width + d
          const inT = ch.output[o] ?? 0
          const outT = ch.output[o + 2 * ch.width] ?? 0
          const before = (time - (ch.input[k - 1] ?? time)) / 3
          const after = ((ch.input[k + 1] ?? time) - time) / 3
          ctx.strokeStyle = 'rgba(255,59,31,0.6)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(xOf(time - before), yOf(v - inT * before))
          ctx.lineTo(xOf(time + after), yOf(v + outT * after))
          ctx.stroke()
        }
        ctx.fillStyle = time <= loop(t) ? RED : '#000'
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
      }
    }
    const px = xOf(loop(t))
    ctx.fillStyle = '#fff'
    ctx.fillRect(px - 0.5, top - 16, 1.5, bottom - top + 24)
    ctx.font = `13px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8a8a8a'
    ctx.fillText(
      `${ch.nodeName ?? ch.node} ${ch.path}   ${ch.interpolation}`.toUpperCase(),
      L,
      top - 22,
    )
  }

  /** The key the channel moves out of at t, or rests on. */
  const keyAt = (ch: GltfChannel, t: number) => {
    let i = 0
    while (i < ch.input.length - 1 && (ch.input[i + 1] as number) <= loop(t)) i++
    return i
  }

  const tops: Word[] = channels.map((c, i) => ({
    from: i * each,
    to: (i + 1) * each,
    text: c.interpolation,
  }))
  const bottoms: Word[] = channels.map((c, i) => ({
    from: i * each,
    to: (i + 1) * each,
    text: c.path.toUpperCase(),
  }))
  const present = [
    ...skins.map((s) => `skin ${s.name ?? s.index} (${s.joints} joints)`),
    ...morphTargets.map((m) => `${m.targets} morph targets on ${m.name ?? `mesh ${m.mesh}`}`),
  ].join(', ')

  return {
    async render(t, o) {
      const focus = focusAt(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      for (const node of nodes) drawNode(node, loop(t), node === focus.node)
      drawGraph(t, focus)
      house.words(tops, bottoms, t, o.frame)
      house.note(`present, not applied: ${present}`, R, 800)
      const v = valueAt(focus, loop(t))
      house.hud(
        t,
        o.frame,
        `${focus.path.toUpperCase()} ${v.map((x) => x.toFixed(2)).join(' ')}`,
        `KEY ${keyAt(focus, t) + 1}/${focus.input.length}   T ${loop(t).toFixed(2)}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const ch = focusAt(t)
      return `${ch.nodeName ?? ch.node} ${ch.path}  key ${keyAt(ch, t) + 1}/${ch.input.length}`
    },
    inspect(t) {
      const ch = focusAt(t)
      return {
        id: 'clip',
        node: ch.node,
        path: ch.path,
        interpolation: ch.interpolation,
        key: keyAt(ch, t),
        value: valueAt(ch, loop(t)),
      }
    },
  }
}

export default motionGltfClips
