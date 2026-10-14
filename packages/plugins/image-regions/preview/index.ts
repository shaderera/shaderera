// image-regions: a cat's face drawn in code in greys, with grain, and one mask per part drawn the
// same way (the head, two eyes, two pupils, the nose). The plugin's own analyser for painted masks
// turns them into a regions artifact, and its reader loads it back through the host's files, as a
// film would. The regions then come in one by one: the mask tinted, the box, the centre, and a line
// to the region that holds it. The pupils are answered as "eye" too, so `leaves` picks them.

import type { Host } from '@shaderera/core'
import { encode } from 'fast-png'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { leaves, loadRegions, maskOf, type Region } from '../../previews/src/image/regions.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { regionsFromMasks } from '../../previews/tools/regions-from-masks.ts'

/** The picture's size, and where it sits. */
const W = 640
const H = 480
const STAGE = { top: 150, bottom: 820 }
/** When the first region comes in, and how long each holds before the next. */
const FIRST = 0.3
const EACH = 0.85

type Ctx = OffscreenCanvasRenderingContext2D
/** The face's parts as paths, in picture pixels; each is a region's mask too. */
const PARTS: { label: string; draw: (g: Ctx) => void }[] = [
  {
    label: 'cat',
    draw: (g) => {
      g.beginPath()
      g.ellipse(320, 270, 190, 165, 0, 0, Math.PI * 2)
      g.fill()
      for (const [a, b, c] of [
        [160, 175, 285],
        [480, 465, 355],
      ] as const) {
        g.beginPath()
        g.moveTo(a, 200)
        g.lineTo(b, 40)
        g.lineTo(c, 125)
        g.closePath()
        g.fill()
      }
    },
  },
  ...[230, 410].map((x) => ({
    label: 'eye',
    draw: (g: Ctx) => {
      g.beginPath()
      g.ellipse(x, 245, 52, 38, x < 320 ? 0.12 : -0.12, 0, Math.PI * 2)
      g.fill()
    },
  })),
  ...[234, 406].map((x) => ({
    label: 'eye',
    draw: (g: Ctx) => {
      g.beginPath()
      g.ellipse(x, 247, 12, 30, 0, 0, Math.PI * 2)
      g.fill()
    },
  })),
  {
    label: 'nose',
    draw: (g) => {
      g.beginPath()
      g.moveTo(296, 318)
      g.lineTo(344, 318)
      g.lineTo(320, 348)
      g.fill()
    },
  },
]
/** The tone each part is painted in, in the picture. */
const TONES = ['#8c8c8c', '#d8d8d8', '#d8d8d8', '#141414', '#141414', '#b0b0b0']

const imageRegions: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`image-regions has no state "${stateId}"`)
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as Ctx
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The picture: a dark ground with a soft light, the parts in their tones, then grain.
  const picture = host.io.canvas(W, H)
  const p = picture.getContext('2d') as Ctx
  const light = p.createRadialGradient(320, 200, 40, 320, 240, 420)
  light.addColorStop(0, '#3a3a3a')
  light.addColorStop(1, '#0c0c0c')
  p.fillStyle = light
  p.fillRect(0, 0, W, H)
  PARTS.forEach((part, i) => {
    p.fillStyle = TONES[i] as string
    part.draw(p)
  })
  const image = p.getImageData(0, 0, W, H)
  for (let i = 0; i < W * H; i++) {
    const n = (((i * 2654435761) >>> 0) % 25) - 12
    for (let c = 0; c < 3; c++) image.data[i * 4 + c] = (image.data[i * 4 + c] as number) + n
  }
  p.putImageData(image, 0, 0)
  const bytes = encode({
    width: W,
    height: H,
    data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    channels: 4,
  })

  // One painted mask per part, through the plugin's analyser, then read back as a film reads it.
  const masks = PARTS.map((part) => {
    const c = host.io.canvas(W, H)
    const g = c.getContext('2d') as Ctx
    g.fillStyle = '#fff'
    part.draw(g)
    const rgba = g.getImageData(0, 0, W, H).data
    const mask = new Uint8Array(W * H)
    for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] as number
    return { label: part.label, mask, width: W, height: H }
  })
  const made = await regionsFromMasks({ path: 'assets/cat.png', bytes }, masks)
  const files = new Map<string, Uint8Array>([
    ['assets/cat.png', bytes],
    ['regions/cat/regions.json', new TextEncoder().encode(made.json)],
    ...made.files.map((f) => [`regions/cat/${f.name}`, f.bytes] as [string, Uint8Array]),
  ])
  const reader = {
    ...host,
    io: {
      ...host.io,
      read: async (path: string) => {
        const b = files.get(path)
        if (!b) throw new Error(`No file ${path}`)
        return b
      },
    },
  } as Host
  const regions = await loadRegions(reader, 'regions/cat')
  const innermost = leaves(regions, 'eye').map((q) => q.id)

  // Each region's mask as a tint, white and red.
  const tint = async (q: Region, rgb: [number, number, number]) => {
    const alpha = await maskOf(reader, regions, q)
    const c = host.io.canvas(q.mask.width, q.mask.height)
    const g = c.getContext('2d') as Ctx
    const px = g.createImageData(q.mask.width, q.mask.height)
    for (let i = 0; i < alpha.length; i++) {
      px.data.set(rgb, i * 4)
      px.data[i * 4 + 3] = alpha[i] as number
    }
    g.putImageData(px, 0, 0)
    return c
  }
  const tints = await Promise.all(
    regions.regions.map(async (q) => ({
      q,
      white: await tint(q, [255, 255, 255]),
      red: await tint(q, [255, 59, 31]),
    })),
  )

  const s = Math.min((R - L) / W, (STAGE.bottom - STAGE.top) / H)
  const ox = (width - W * s) / 2
  const oy = STAGE.top + (STAGE.bottom - STAGE.top - H * s) / 2
  const X = (x: number) => ox + x * s
  const Y = (y: number) => oy + y * s
  const byId = new Map(regions.regions.map((q) => [q.id, q]))

  const state = (t: number) => {
    const shown = Math.max(0, Math.min(tints.length, Math.floor((t - FIRST) / EACH) + 1))
    return { shown, current: shown > 0 ? tints[shown - 1]?.q : undefined }
  }
  const words: Word[] = [{ from: 0, to: 99, text: 'REGIONS' }]

  return {
    async render(t, o) {
      const { shown, current } = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      ctx.drawImage(picture as unknown as CanvasImageSource, ox, oy, W * s, H * s)

      for (const { q, white, red } of tints.slice(0, shown)) {
        const now = q === current
        ctx.globalAlpha = now ? 0.5 : 0.18
        ctx.drawImage(
          (now ? red : white) as unknown as CanvasImageSource,
          X(q.mask.at[0]),
          Y(q.mask.at[1]),
          q.mask.width * s,
          q.mask.height * s,
        )
        ctx.globalAlpha = 1
        const [bx, by, bw, bh] = q.box
        ctx.strokeStyle = now ? RED : 'rgba(255,255,255,0.35)'
        ctx.lineWidth = now ? 2 : 1
        ctx.strokeRect(X(bx) - 0.5, Y(by) - 0.5, bw * s + 1, bh * s + 1)
        const [cx, cy] = q.centre
        ctx.strokeStyle = now ? '#fff' : 'rgba(255,255,255,0.5)'
        ctx.beginPath()
        ctx.moveTo(X(cx) - 7, Y(cy))
        ctx.lineTo(X(cx) + 7, Y(cy))
        ctx.moveTo(X(cx), Y(cy) - 7)
        ctx.lineTo(X(cx), Y(cy) + 7)
        ctx.stroke()
      }
      if (current) {
        const parent = current.parent ? byId.get(current.parent) : undefined
        if (parent) {
          ctx.setLineDash([4, 5])
          ctx.strokeStyle = 'rgba(255,255,255,0.8)'
          ctx.beginPath()
          ctx.moveTo(X(current.centre[0]), Y(current.centre[1]))
          ctx.lineTo(X(parent.centre[0]), Y(parent.centre[1]))
          ctx.stroke()
          ctx.setLineDash([])
        }
        const label = `${current.id}  [${current.box.join(' ')}]`
        ctx.font = `14px ${mono}`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        const lw = ctx.measureText(label).width + 12
        const lx = Math.min(R - lw, Math.max(L, X(current.box[0]) - 1))
        const ly = Y(current.box[1]) - 22
        ctx.fillStyle = RED
        ctx.fillRect(lx, ly, lw, 20)
        ctx.fillStyle = '#000'
        ctx.fillText(label, lx + 6, ly + 15)
      }

      house.words(
        words,
        [{ from: 0, to: 99, text: current ? current.id.toUpperCase() : '·' }],
        t,
        o.frame,
      )
      if (current)
        house.note(
          current.parent
            ? `inside ${current.parent}${innermost.includes(current.id) ? ', a leaf' : ''}`
            : 'held by nothing',
        )
      house.hud(
        t,
        o.frame,
        `${regions.regions.length} REGIONS   ${W}×${H}   FROM PAINTED MASKS`,
        `LEAVES OF EYE  ${innermost.join(' ')}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return state(t).current?.id ?? ''
    },
    inspect(t) {
      const { current } = state(t)
      return {
        id: 'regions',
        current: current?.id ?? null,
        parent: current?.parent ?? null,
        leaves: innermost,
      }
    },
  }
}

export default imageRegions
