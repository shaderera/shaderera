// One glyph outline, or a word, morphing into another. Every contour is resampled to the same
// number of points by arc length, contours are paired (outers with outers, holes with holes,
// nearest first), each partner is wound the same way and turned so its points lie nearest, and a
// contour with no partner grows from, or shrinks to, a point. Then any two shapes lerp, and the
// in-between is a pure function of k. Built on text-glyph-outlines; no look: rings of points.
//
// Units: ems (size 1), y up, the pen at 0 and the baseline at y 0, as glyphOutlines gives them.

import { type Font, glyphOutlines } from './outlines.ts'

/** One closed contour: `points` x, y pairs. */
export type Ring = Float32Array

/** Contours ready to morph, every one with the same number of points, and the advance width. */
export type Shape = { rings: Ring[]; width: number }

/** A morph from one shape to another: `at(0)` is `a`, `at(1)` is `b`, and between, both. */
export type Morph = { at(k: number): Shape }

export type ShapeOptions = {
  /** Points per contour (default 160); shapes morph only with the same count. */
  points?: number
  /** Furthest a flattened curve strays from the true curve, in ems (default 0.0015). */
  tolerance?: number
  kerning?: boolean
  letterSpacing?: number
  /** A variable font's axes: `{ wght: 700 }`. */
  variation?: Record<string, number>
}

const signedArea = (r: Ring) => {
  let s = 0
  const n = r.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s +=
      (r[i * 2] as number) * (r[j * 2 + 1] as number) -
      (r[j * 2] as number) * (r[i * 2 + 1] as number)
  }
  return s / 2
}

const centroid = (r: Ring): [number, number] => {
  let x = 0
  let y = 0
  const n = r.length / 2
  for (let i = 0; i < n; i++) {
    x += r[i * 2] as number
    y += r[i * 2 + 1] as number
  }
  return [x / n, y / n]
}

const dot = (n: number, [x, y]: [number, number]): Ring => {
  const r = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    r[i * 2] = x
    r[i * 2 + 1] = y
  }
  return r
}

/** A closed polyline (points `[a, b)` of `pts`) resampled to `n` points evenly by arc length. */
const resample = (pts: Float32Array, a: number, b: number, n: number): Ring => {
  const m = b - a
  const cum = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) {
    const p = a + i
    const q = a + ((i + 1) % m)
    cum[i + 1] =
      (cum[i] as number) +
      Math.hypot(
        (pts[q * 2] as number) - (pts[p * 2] as number),
        (pts[q * 2 + 1] as number) - (pts[p * 2 + 1] as number),
      )
  }
  const total = cum[m] as number
  const out = new Float32Array(n * 2)
  let seg = 0
  for (let k = 0; k < n; k++) {
    const d = (k / n) * total
    while (seg < m - 1 && (cum[seg + 1] as number) < d) seg++
    const len = (cum[seg + 1] as number) - (cum[seg] as number) || 1
    const f = (d - (cum[seg] as number)) / len
    const p = a + seg
    const q = a + ((seg + 1) % m)
    out[k * 2] = (pts[p * 2] as number) + ((pts[q * 2] as number) - (pts[p * 2] as number)) * f
    out[k * 2 + 1] =
      (pts[p * 2 + 1] as number) + ((pts[q * 2 + 1] as number) - (pts[p * 2 + 1] as number)) * f
  }
  return out
}

const outlinesOf = (font: Font, text: string, o: ShapeOptions) => {
  const n = o.points ?? 160
  if (!(Number.isInteger(n) && n >= 3)) throw new Error(`points must be an integer >= 3, got ${n}`)
  const out = glyphOutlines(font, text, {
    tolerance: o.tolerance ?? 0.0015,
    ...(o.kerning === undefined ? {} : { kerning: o.kerning }),
    ...(o.letterSpacing === undefined ? {} : { letterSpacing: o.letterSpacing }),
    ...(o.variation ? { variation: o.variation } : {}),
  })
  const ring = (c: number) =>
    resample(out.points, out.contours[c] as number, out.contours[c + 1] as number, n)
  return { out, ring }
}

/** `text` (a glyph or a word) as one shape: its contours resampled, the word's width. */
export const shapeOf = (font: Font, text: string, o: ShapeOptions = {}): Shape => {
  const { out, ring } = outlinesOf(font, text, o)
  const rings: Ring[] = []
  for (let c = 0; c + 1 < out.contours.length; c++) rings.push(ring(c))
  return { rings, width: out.width }
}

/** `text` as one shape per glyph, each where it sits in the word; `width` is its advance. */
export const lettersOf = (font: Font, text: string, o: ShapeOptions = {}): Shape[] => {
  const { out, ring } = outlinesOf(font, text, o)
  return out.glyphs.map((g) => {
    const rings: Ring[] = []
    for (let c = g.contours[0]; c < g.contours[1]; c++) rings.push(ring(c))
    return { rings, width: g.advance }
  })
}

/** `b` wound like `a` and turned so its points lie nearest a's (compared about their centroids). */
const align = (a: Ring, b: Ring): Ring => {
  const n = a.length / 2
  let src = b
  if (Math.sign(signedArea(a)) !== Math.sign(signedArea(b))) {
    src = new Float32Array(b.length)
    for (let i = 0; i < n; i++) {
      src[i * 2] = b[(n - 1 - i) * 2] as number
      src[i * 2 + 1] = b[(n - 1 - i) * 2 + 1] as number
    }
  }
  const [ax, ay] = centroid(a)
  const [bx, by] = centroid(src)
  let best = 0
  let bestCost = Infinity
  const step = Math.max(1, Math.floor(n / 64))
  for (let s = 0; s < n; s++) {
    let cost = 0
    for (let i = 0; i < n; i += step) {
      const j = (i + s) % n
      const dx = (a[i * 2] as number) - ax - ((src[j * 2] as number) - bx)
      const dy = (a[i * 2 + 1] as number) - ay - ((src[j * 2 + 1] as number) - by)
      cost += dx * dx + dy * dy
      if (cost >= bestCost) break
    }
    if (cost < bestCost) {
      bestCost = cost
      best = s
    }
  }
  const out = new Float32Array(src.length)
  for (let i = 0; i < n; i++) {
    const j = (i + best) % n
    out[i * 2] = src[j * 2] as number
    out[i * 2 + 1] = src[j * 2 + 1] as number
  }
  return out
}

/** Pairs of ring indices, outers with outers and holes with holes, nearest first; -1 for none. */
const match = (as: Ring[], bs: Ring[]): [number, number][] => {
  const info = (rs: Ring[]) => {
    const areas = rs.map(signedArea)
    const big = areas.reduce((m, x, i) => (Math.abs(x) > Math.abs(areas[m] ?? 0) ? i : m), 0)
    const sign = Math.sign(areas[big] ?? 1)
    return rs.map((r, i) => ({
      c: centroid(r),
      area: Math.abs(areas[i] ?? 0),
      outer: Math.sign(areas[i] ?? 0) === sign,
    }))
  }
  const ia = info(as)
  const ib = info(bs)
  const pairs: { i: number; j: number; cost: number }[] = []
  for (const [i, a] of ia.entries())
    for (const [j, b] of ib.entries()) {
      if (a.outer !== b.outer) continue
      const d = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1])
      const size = Math.abs(Math.log((a.area + 1e-6) / (b.area + 1e-6)))
      pairs.push({ i, j, cost: d + 0.15 * size })
    }
  // Ties broken by index, so the pairing never depends on the sort's stability.
  pairs.sort((x, y) => x.cost - y.cost || x.i - y.i || x.j - y.j)
  const usedA = new Set<number>()
  const usedB = new Set<number>()
  const out: [number, number][] = []
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue
    usedA.add(p.i)
    usedB.add(p.j)
    out.push([p.i, p.j])
  }
  for (let i = 0; i < as.length; i++) if (!usedA.has(i)) out.push([i, -1])
  for (let j = 0; j < bs.length; j++) if (!usedB.has(j)) out.push([-1, j])
  return out
}

const pointsOf = (a: Shape, b: Shape) => {
  const n = (a.rings[0] ?? b.rings[0])?.length ?? 0
  for (const r of [...a.rings, ...b.rings])
    if (r.length !== n)
      throw new Error('morphOf: every ring needs the same number of points (shapeOf `points`)')
  return n / 2
}

/**
 * The morph from shape `a` to shape `b`. The pairing is worked out once, here; `at(k)` is then a
 * plain lerp (k 0 to 1; ease it yourself). An empty shape morphs everything in from points.
 */
export const morphOf = (a: Shape, b: Shape): Morph => {
  const n = pointsOf(a, b)
  const pairs: [Ring, Ring][] = match(a.rings, b.rings).map(([i, j]) => {
    const ra = a.rings[i]
    const rb = b.rings[j]
    if (ra && rb) return [ra, align(ra, rb)]
    if (ra) return [ra, dot(n, centroid(ra))]
    const r = rb as Ring
    return [dot(n, centroid(r)), r]
  })
  return {
    at(k) {
      const c = Math.min(1, Math.max(0, k))
      const rings = pairs.map(([ra, rb]) => {
        const out = new Float32Array(ra.length)
        for (let i = 0; i < ra.length; i++)
          out[i] = (ra[i] as number) + ((rb[i] as number) - (ra[i] as number)) * c
        return out
      })
      return { rings, width: a.width + (b.width - a.width) * c }
    },
  }
}

const EMPTY: Shape = { rings: [], width: 0 }

/** Letter i of `a` into letter i of `b`; a letter with no partner grows from, or shrinks to, points. */
export const morphLetters = (a: Shape[], b: Shape[]): Morph[] =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
    morphOf(a[i] ?? EMPTY, b[i] ?? EMPTY),
  )

/** The rings' extent: [xMin, yMin, xMax, yMax], or undefined for no rings. */
export const boundsOf = (rings: readonly Ring[]): [number, number, number, number] | undefined => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rings)
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i] as number)
      x1 = Math.max(x1, r[i] as number)
      y0 = Math.min(y0, r[i + 1] as number)
      y1 = Math.max(y1, r[i + 1] as number)
    }
  return x1 >= x0 ? [x0, y0, x1, y1] : undefined
}

/** The part of a Canvas2D context (or Path2D) that `tracePath` draws with. */
export type PathSink = {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
}

/**
 * Adds the rings to a Canvas2D path: the pen at `x`, the baseline at `y`, `size` px per em (y
 * flipped to the canvas's). Fill it with 'nonzero' and holes stay holes.
 */
export const tracePath = (
  ctx: PathSink,
  rings: readonly Ring[],
  at: { x: number; y: number; size: number },
) => {
  for (const r of rings) {
    const n = r.length / 2
    ctx.moveTo(at.x + (r[0] as number) * at.size, at.y - (r[1] as number) * at.size)
    for (let i = 1; i < n; i++)
      ctx.lineTo(at.x + (r[i * 2] as number) * at.size, at.y - (r[i * 2 + 1] as number) * at.size)
    ctx.closePath()
  }
}
