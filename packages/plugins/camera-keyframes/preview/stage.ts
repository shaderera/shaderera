// The stand-in subject the camera previews film: a plain grey box on a thin floor grid, drawn in
// Canvas2D through a view-projection matrix (camera-keyframes' viewProjection) as white and grey
// lines on black. Nothing in it moves: every change on screen is the camera. camera-shake's
// preview uses it too.

type Ctx = OffscreenCanvasRenderingContext2D
type V3 = readonly [number, number, number]

/** The box: a cube of this side standing on the floor at the origin. */
export const BOX = 2.4
/** The box's centre and the radius of the sphere round it, for `fit`. */
export const SUBJECT = { center: [0, BOX / 2, 0] as V3, radius: (BOX / 2) * Math.sqrt(3) }

const NEAR = 0.05

/** A world point through `vp` to pixels (y down), or null behind the camera. */
export const project = (
  vp: ArrayLike<number>,
  p: V3,
  width: number,
  height: number,
): { x: number; y: number; w: number } | null => {
  const c = clip(vp, p)
  if (c.w < NEAR) return null
  return { x: (c.x / c.w + 1) * 0.5 * width, y: (1 - c.y / c.w) * 0.5 * height, w: c.w }
}

const clip = (vp: ArrayLike<number>, p: V3) => {
  const m = (i: number) => vp[i] ?? 0
  return {
    x: m(0) * p[0] + m(4) * p[1] + m(8) * p[2] + m(12),
    y: m(1) * p[0] + m(5) * p[1] + m(9) * p[2] + m(13),
    w: m(3) * p[0] + m(7) * p[1] + m(11) * p[2] + m(15),
  }
}

const H = BOX / 2
const CORNERS: V3[] = [
  [-H, 0, -H],
  [H, 0, -H],
  [H, 0, H],
  [-H, 0, H],
  [-H, BOX, -H],
  [H, BOX, -H],
  [H, BOX, H],
  [-H, BOX, H],
]
/** Each face: its corners in order and its outward normal. */
const FACES: { k: readonly number[]; n: V3 }[] = [
  { k: [4, 5, 6, 7], n: [0, 1, 0] },
  { k: [0, 1, 2, 3], n: [0, -1, 0] },
  { k: [0, 1, 5, 4], n: [0, 0, -1] },
  { k: [3, 2, 6, 7], n: [0, 0, 1] },
  { k: [0, 3, 7, 4], n: [-1, 0, 0] },
  { k: [1, 2, 6, 5], n: [1, 0, 0] },
]
/** A fixed light from above and to one side, so the faces read as greys. */
const LIGHT: V3 = [-0.45, 0.8, 0.4]

/** The floor grid: one line a unit, every fifth brighter, fading out with distance. */
const GRID = 16

export const createStage = (ctx: Ctx, width: number, height: number) => {
  /** A world segment through `vp`, clipped at the near plane. */
  const segment = (vp: ArrayLike<number>, a: V3, b: V3) => {
    let p = clip(vp, a)
    let q = clip(vp, b)
    if (p.w < NEAR && q.w < NEAR) return
    if (p.w < NEAR || q.w < NEAR) {
      const u = (NEAR - p.w) / (q.w - p.w)
      const cut = { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, w: NEAR }
      if (p.w < NEAR) p = cut
      else q = cut
    }
    ctx.moveTo((p.x / p.w + 1) * 0.5 * width, (1 - p.y / p.w) * 0.5 * height)
    ctx.lineTo((q.x / q.w + 1) * 0.5 * width, (1 - q.y / q.w) * 0.5 * height)
  }

  const grid = (vp: ArrayLike<number>) => {
    ctx.lineWidth = 1
    // Short pieces, so each can fade by its distance from the box.
    for (let ring = 0; ring < GRID; ring++) {
      const fade = (1 - ring / GRID) ** 1.6
      for (const major of [false, true]) {
        ctx.strokeStyle = `rgba(255,255,255,${(major ? 0.42 : 0.18) * fade})`
        ctx.beginPath()
        for (let i = -GRID; i <= GRID; i++) {
          if ((i % 5 === 0) !== major) continue
          for (const s of [-ring - 1, ring]) {
            segment(vp, [i, 0, s], [i, 0, s + 1])
            segment(vp, [s, 0, i], [s + 1, 0, i])
          }
        }
        ctx.stroke()
      }
    }
  }

  const box = (vp: ArrayLike<number>, eye: V3) => {
    ctx.lineJoin = 'round'
    for (const f of FACES) {
      const c = f.k.map((k) => CORNERS[k] as V3)
      const mid = c.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [
        0, 0, 0,
      ] as [number, number, number])
      const toEye = [eye[0] - mid[0], eye[1] - mid[1], eye[2] - mid[2]]
      if (f.n[0] * (toEye[0] ?? 0) + f.n[1] * (toEye[1] ?? 0) + f.n[2] * (toEye[2] ?? 0) <= 0)
        continue
      const pts = c.map((p) => project(vp, p, width, height))
      const lit = Math.max(0, f.n[0] * LIGHT[0] + f.n[1] * LIGHT[1] + f.n[2] * LIGHT[2])
      const g = Math.round(26 + 46 * lit)
      if (pts.every((p) => p)) {
        ctx.fillStyle = `rgb(${g},${g},${g})`
        ctx.beginPath()
        for (const [i, p] of pts.entries()) {
          if (!p) continue
          if (i === 0) ctx.moveTo(p.x, p.y)
          else ctx.lineTo(p.x, p.y)
        }
        ctx.closePath()
        ctx.fill()
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let i = 0; i < 4; i++) segment(vp, c[i] as V3, c[(i + 1) % 4] as V3)
      ctx.stroke()
    }
  }

  return {
    /** The floor grid and the box through `vp`, seen from `eye`, onto a black ground. */
    draw(vp: ArrayLike<number>, eye: V3) {
      ctx.save()
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      grid(vp)
      box(vp, eye)
      ctx.restore()
    },
  }
}
