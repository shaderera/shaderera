// render-gltf-read: a plain stand-in model made in code as GLB bytes (preview/model.ts), read by
// the plugin through the host's files, as a film would. The picture is only what came back: every
// primitive's triangles from its positions and indices, put through its node's world matrix, shaded
// by its normals and its material's base colour, drawn flat in Canvas2D. The view turns once round a
// loop; a red outline steps from primitive to primitive with what the plugin returned for it.

import type { Host } from '@shaderera/core'
import { createHouse, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { type GltfPrimitive, loadGltf } from '../../previews/src/render/gltf.ts'
import { makeModel } from './model.ts'

type V3 = [number, number, number]
const TAU = Math.PI * 2
/** The picture's centre, its scale in pixels a model unit, and the view's tilt. */
const CENTRE = { x: 540, y: 520 }
const SCALE = 190
const TILT = 0.42
/** The direction light comes from, in view space. */
const LIGHT: V3 = [-0.45, 0.7, 0.55]

const apply = (m: readonly number[], x: number, y: number, z: number, w = 1): V3 => [
  (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0) * w,
  (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0) * w,
  (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0) * w,
]

const renderGltfRead: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-gltf-read has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The model's bytes as a project file, read back by the plugin.
  const glb = makeModel()
  const reader = {
    ...host,
    io: {
      ...host.io,
      read: async (path: string) => {
        if (path !== 'assets/blocks.glb') throw new Error(`No file ${path}`)
        return glb
      },
    },
  } as Host
  const { primitives } = await loadGltf(reader, 'assets/blocks.glb')
  const each = duration / primitives.length

  /** From the model to the view: turned about y by `az`, tilted, y up and z towards the eye. */
  const toView = (az: number, [x, y, z]: V3): V3 => {
    const rx = x * Math.cos(az) + z * Math.sin(az)
    const rz = -x * Math.sin(az) + z * Math.cos(az)
    return [rx, y * Math.cos(TILT) - rz * Math.sin(TILT), y * Math.sin(TILT) + rz * Math.cos(TILT)]
  }
  const screen = ([x, y, z]: V3): [number, number] => {
    const f = 9 / (9 - z)
    return [CENTRE.x + x * SCALE * f, CENTRE.y - (y - 0.3) * SCALE * f]
  }

  /** Every front-facing triangle of the model, far to near, with its primitive. */
  const triangles = (az: number) => {
    const out: { p: GltfPrimitive; pts: [number, number][]; depth: number; shade: number }[] = []
    for (const p of primitives) {
      const world = (i: number) =>
        toView(
          az,
          apply(
            p.matrix,
            p.positions[i * 3] ?? 0,
            p.positions[i * 3 + 1] ?? 0,
            p.positions[i * 3 + 2] ?? 0,
          ),
        )
      const normal = (i: number) =>
        toView(
          az,
          apply(
            p.matrix,
            p.normals?.[i * 3] ?? 0,
            p.normals?.[i * 3 + 1] ?? 0,
            p.normals?.[i * 3 + 2] ?? 0,
            0,
          ),
        )
      for (let t = 0; t < p.indices.length; t += 3) {
        const ids = [p.indices[t] ?? 0, p.indices[t + 1] ?? 0, p.indices[t + 2] ?? 0]
        const n = ids.map(normal).reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]])
        const l = Math.hypot(...n) || 1
        if (n[2] / l <= 0.001) continue
        const v = ids.map(world)
        const lit = Math.max(
          0,
          (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / l / Math.hypot(...LIGHT),
        )
        out.push({
          p,
          pts: v.map(screen),
          depth: v.reduce((s, q) => s + q[2], 0) / 3,
          shade: (0.25 + 0.75 * lit) * (p.material.baseColor[0] ?? 1),
        })
      }
    }
    return out.sort((a, b) => a.depth - b.depth)
  }

  const state = (t: number) => {
    const i = Math.min(primitives.length - 1, Math.floor(t / each))
    return { i, current: primitives[i] as GltfPrimitive, since: t - i * each }
  }
  const words: Word[] = [{ from: 0, to: 99, text: 'GLB' }]

  return {
    async render(t, o) {
      const { current, since } = state(t)
      const az = (t / duration) * TAU + 0.5
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      const tris = triangles(az)
      ctx.save()
      ctx.lineJoin = 'round'
      for (const { pts, shade } of tris) {
        const g = Math.round(255 * Math.min(1, shade))
        ctx.fillStyle = `rgb(${g},${g},${g})`
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (const [k, [x, y]] of pts.entries()) k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
      // The current primitive's triangles, outlined in red over everything.
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      let top = Number.POSITIVE_INFINITY
      let left = Number.POSITIVE_INFINITY
      for (const { p, pts } of tris) {
        if (p !== current) continue
        ctx.beginPath()
        for (const [k, [x, y]] of pts.entries()) {
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
          top = Math.min(top, y)
          left = Math.min(left, x)
        }
        ctx.closePath()
        ctx.stroke()
      }
      const label = `${current.name}  ${current.count} VERTS  ${current.indices.length / 3} TRIS`
      ctx.font = `14px ${mono}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      const lw = ctx.measureText(label).width + 12
      const lx = Math.min(1032 - lw, Math.max(48, left))
      const ly = Math.max(150, top - 34)
      ctx.fillStyle = RED
      ctx.fillRect(lx, ly, lw, 20)
      ctx.fillStyle = '#000'
      ctx.fillText(label, lx + 6, ly + 15)
      ctx.restore()

      house.words(
        words,
        [{ from: t - since, to: t - since + each, text: current.name.toUpperCase() }],
        t,
        o.frame,
      )
      house.note(
        `node ${current.node}, mesh ${current.mesh}${current.material.name ? `, ${current.material.name}` : ''}`,
      )
      const [x, y, z] = [12, 13, 14].map((k) => (current.matrix[k] ?? 0).toFixed(2))
      house.hud(
        t,
        o.frame,
        `${primitives.length} PRIMITIVES   ${glb.length} BYTES   NO PACKAGES`,
        `WORLD ${x} ${y} ${z}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return state(t).current.name
    },
    inspect(t) {
      const { current } = state(t)
      return {
        id: 'gltf',
        primitive: current.name,
        node: current.node,
        mesh: current.mesh,
        count: current.count,
        matrix: [...current.matrix],
      }
    },
  }
}

export default renderGltfRead
