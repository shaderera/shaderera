// Text as geometry from a font file: outlines as contours, fill triangles, and a closed extruded
// mesh. The font is parsed in JavaScript (opentype.js) and filled with earcut, so Node and the
// browser give the same numbers. No look: positions, normals and indices only.
//
// Units: `size` is the em (1 by default), y up, origin at the baseline where the text starts.

import type { Host } from '@shaderera/core'
import earcut from 'earcut'
import type { Font, Glyph } from 'opentype.js'
import * as opentype from 'opentype.js'

export type { Font } from 'opentype.js'

/** One outline command in output units, y up, already placed at its glyph's pen position. */
export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' }

export type GlyphOutline = {
  /** The glyph's index in the font. */
  id: number
  unicode: number | undefined
  /** Pen position: where this glyph's advance box starts, in output units. */
  x: number
  /** The glyph's own advance width (without kerning or letter spacing). */
  advance: number
  /** Contours `[first, end)` of this glyph in `Outlines.contours`. */
  contours: [number, number]
  /** Of its flattened points: [xMin, yMin, xMax, yMax]; [x, 0, x, 0] for a glyph with no ink. */
  bounds: [number, number, number, number]
  /** The curves as the font has them (quadratic for TrueType, cubic for CFF), scaled and placed. */
  commands: PathCommand[]
}

export type Outlines = {
  /** x, y pairs of every contour, flattened, one after another. */
  points: Float32Array
  /** Contour i is points (pairs) `[contours[i], contours[i + 1])`; length is contour count + 1. */
  contours: Uint32Array
  glyphs: GlyphOutline[]
  /** From the first pen position to the end of the last glyph's advance. */
  width: number
  /** The font's ascender and descender at `size` (descender is negative). */
  ascender: number
  descender: number
  size: number
}

/** Triangles of a set of index ranges: `[start, start + count)` in `indices`, one per glyph. */
export type GlyphRange = { start: number; count: number }

export type Fill = {
  /** x, y pairs: the outline points (a copy of `Outlines.points`). */
  positions: Float32Array
  /** Triangles, counter-clockwise seen from +z. */
  indices: Uint32Array
  glyphs: GlyphRange[]
}

export type Solid = {
  /** x, y, z: front cap at z = 0, back cap at z = -depth, then the side walls. */
  positions: Float32Array
  /** Unit normals per vertex: (0, 0, 1) front, (0, 0, -1) back, flat per wall segment. */
  normals: Float32Array
  /** Triangles, counter-clockwise seen from outside. */
  indices: Uint32Array
  glyphs: GlyphRange[]
}

// Node loads the package's CommonJS build (only a default export); a bundler loads its ES build
// (only named exports). Read through Reflect so neither build trips the other's analysis.
const parse: typeof opentype.parse =
  (Reflect.get(opentype, 'parse') as typeof opentype.parse | undefined) ??
  (Reflect.get(opentype, 'default') as { parse: typeof opentype.parse }).parse

/** Reads a TTF, OTF or WOFF file at `path` (relative to the project) and parses it. */
export const loadFont = async (host: Host, path: string): Promise<Font> => {
  const bytes = await host.io.read(path)
  return parse(new Uint8Array(bytes).buffer)
}

/**
 * `text` in `font` as outlines. `letterSpacing` is in ems, added between glyphs. `tolerance` is
 * the furthest a flattened curve may stray from the true curve, in output units (default
 * size / 1000). `variation` sets a variable font's axes ({ wght: 700 }). `ligatures` lets the
 * font's liga and rlig substitutions merge letters (off: one Latin glyph per character).
 */
export const glyphOutlines = (
  font: Font,
  text: string,
  o: {
    size?: number
    letterSpacing?: number
    kerning?: boolean
    tolerance?: number
    variation?: Record<string, number>
    ligatures?: boolean
  } = {},
): Outlines => {
  const size = o.size ?? 1
  const s = size / font.unitsPerEm
  const tolerance = o.tolerance ?? size / 1000
  if (!(tolerance > 0)) throw new Error(`glyphOutlines: tolerance must be > 0, got ${tolerance}`)
  const ligatures = o.ligatures ?? false
  const glyphs = font.stringToGlyphs(text, { features: { liga: ligatures, rlig: ligatures } })
  const kerning = o.kerning ?? true
  const tables = kerning
    ? font.position.getKerningTables(font.position.getDefaultScriptName())
    : undefined
  const spacing = (o.letterSpacing ?? 0) * font.unitsPerEm

  const xy: number[] = []
  const starts: number[] = []
  const out: GlyphOutline[] = []
  let pen = 0
  let end = 0
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i] as Glyph
    const shape = o.variation && font.variation ? font.variation.getTransform(g, o.variation) : g
    const x0 = pen * s
    const X = (v: number) => x0 + v * s
    const Y = (v: number) => v * s
    const commands = shape.path.commands.map((c): PathCommand => {
      if (c.type === 'Z') return { type: 'Z' }
      if (c.type === 'M' || c.type === 'L') return { type: c.type, x: X(c.x), y: Y(c.y) }
      if (c.type === 'Q') return { type: 'Q', x1: X(c.x1), y1: Y(c.y1), x: X(c.x), y: Y(c.y) }
      return { type: 'C', x1: X(c.x1), y1: Y(c.y1), x2: X(c.x2), y2: Y(c.y2), x: X(c.x), y: Y(c.y) }
    })
    const first = starts.length
    flatten(commands, tolerance, xy, starts)
    let bounds: [number, number, number, number] = [x0, 0, x0, 0]
    if (starts.length > first) {
      bounds = [Infinity, Infinity, -Infinity, -Infinity]
      for (let k = (starts[first] as number) * 2; k < xy.length; k += 2) {
        const px = xy[k] as number
        const py = xy[k + 1] as number
        if (px < bounds[0]) bounds[0] = px
        if (py < bounds[1]) bounds[1] = py
        if (px > bounds[2]) bounds[2] = px
        if (py > bounds[3]) bounds[3] = py
      }
    }
    const advance = (shape.advanceWidth ?? 0) * s
    out.push({
      id: g.index,
      unicode: g.unicode,
      x: x0,
      advance,
      contours: [first, starts.length],
      bounds,
      commands,
    })
    end = x0 + advance
    pen += shape.advanceWidth ?? 0
    const next = glyphs[i + 1]
    if (next) {
      if (kerning)
        pen += tables
          ? font.position.getKerningValue(tables, g.index, next.index)
          : font.getKerningValue(g, next)
      pen += spacing
    }
  }
  starts.push(xy.length / 2)
  return {
    points: new Float32Array(xy),
    contours: new Uint32Array(starts),
    glyphs: out,
    width: end,
    ascender: font.ascender * s,
    descender: font.descender * s,
    size,
  }
}

// Curves to polylines with uniform steps, as many as the curve's bend needs to stay within
// `tol` (the chord error of a step h is at most max|B''| h² / 8). Each finished contour is cleaned
// in float32: repeated points, a closing point equal to the first, and exactly collinear points
// are dropped (earcut would drop them too and leave the caps and walls disagreeing).
const flatten = (commands: PathCommand[], tol: number, xy: number[], starts: number[]) => {
  let ring: number[] = []
  let cx = 0
  let cy = 0
  const close = () => {
    const r = clean(ring)
    if (r.length >= 6) {
      starts.push(xy.length / 2)
      for (const v of r) xy.push(v)
    }
    ring = []
  }
  const steps = (bend: number) =>
    Math.min(1024, Math.max(1, Math.ceil(Math.sqrt(bend / (8 * tol)))))
  for (const c of commands) {
    if (c.type === 'Z') {
      close()
      continue
    }
    if (c.type === 'M') {
      if (ring.length) close()
      ring.push(c.x, c.y)
    } else if (c.type === 'Q') {
      // B'' = 2 (p0 - 2 p1 + p2)
      const n = steps(2 * Math.hypot(cx - 2 * c.x1 + c.x, cy - 2 * c.y1 + c.y))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        ring.push(
          u * u * cx + 2 * u * t * c.x1 + t * t * c.x,
          u * u * cy + 2 * u * t * c.y1 + t * t * c.y,
        )
      }
    } else if (c.type === 'L') ring.push(c.x, c.y)
    else {
      // |B''| <= 6 max(|p0 - 2 p1 + p2|, |p1 - 2 p2 + p3|)
      const d1 = Math.hypot(cx - 2 * c.x1 + c.x2, cy - 2 * c.y1 + c.y2)
      const d2 = Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y)
      const n = steps(6 * Math.max(d1, d2))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        const a = u * u * u
        const b = 3 * u * u * t
        const d = 3 * u * t * t
        const e = t * t * t
        ring.push(a * cx + b * c.x1 + d * c.x2 + e * c.x, a * cy + b * c.y1 + d * c.y2 + e * c.y)
      }
    }
    cx = c.x
    cy = c.y
  }
  if (ring.length) close()
}

const clean = (ring: number[]): number[] => {
  const pts: [number, number][] = []
  for (let i = 0; i < ring.length; i += 2) {
    const x = Math.fround(ring[i] as number)
    const y = Math.fround(ring[i + 1] as number)
    const last = pts[pts.length - 1]
    if (!last || last[0] !== x || last[1] !== y) pts.push([x, y])
  }
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    for (let i = 0; i < pts.length && pts.length >= 3; ) {
      const p = pts[(i + pts.length - 1) % pts.length] as [number, number]
      const q = pts[i] as [number, number]
      const r = pts[(i + 1) % pts.length] as [number, number]
      const same = p[0] === q[0] && p[1] === q[1]
      // earcut's own collinearity test, so it finds nothing left to drop
      if (same || (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]) === 0) {
        pts.splice(i, 1)
        changed = true
      } else i++
    }
  }
  return pts.length >= 3 ? pts.flat() : []
}

const area = (pts: Float32Array, a: number, b: number) => {
  let sum = 0
  for (let i = a; i < b; i++) {
    const j = i + 1 < b ? i + 1 : a
    sum += (pts[i * 2] as number) * (pts[j * 2 + 1] as number)
    sum -= (pts[j * 2] as number) * (pts[i * 2 + 1] as number)
  }
  return sum / 2
}

const inside = (pts: Float32Array, a: number, b: number, x: number, y: number) => {
  let odd = false
  for (let i = a, j = b - 1; i < b; j = i++) {
    const xi = pts[i * 2] as number
    const yi = pts[i * 2 + 1] as number
    const xj = pts[j * 2] as number
    const yj = pts[j * 2 + 1] as number
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd
  }
  return odd
}

type Polygon = { outer: number; holes: number[] }

// Which contours are holes, and in which outer. The largest contour of a glyph is an outer, and
// every contour wound the same way is too; the rest are holes (TrueType winds outers clockwise,
// CFF counter-clockwise, so the sign alone decides nothing). A hole belongs to the smallest outer
// that contains most of its points. `flip[c]` says contour c must be walked backwards to have
// its filled side on the left.
const polygonsOf = (o: Outlines) => {
  const n = o.contours.length - 1
  const areas = Array.from({ length: n }, (_, c) =>
    area(o.points, o.contours[c] as number, o.contours[c + 1] as number),
  )
  const flip = new Array<boolean>(n).fill(false)
  const perGlyph: Polygon[][] = []
  for (const g of o.glyphs) {
    const [c0, c1] = g.contours
    let big = c0
    for (let c = c0; c < c1; c++)
      if (Math.abs(areas[c] as number) > Math.abs(areas[big] as number)) big = c
    const sign = Math.sign(areas[big] ?? 0) || 1
    const polys: Polygon[] = []
    const byOuter = new Map<number, Polygon>()
    const holes: number[] = []
    for (let c = c0; c < c1; c++) {
      if (Math.sign(areas[c] as number) === sign) {
        const p = { outer: c, holes: [] }
        polys.push(p)
        byOuter.set(c, p)
      } else holes.push(c)
    }
    for (const h of holes) {
      const a = o.contours[h] as number
      const b = o.contours[h + 1] as number
      let best = -1
      for (const p of polys) {
        if (!byOuter.has(p.outer)) continue
        const oa = o.contours[p.outer] as number
        const ob = o.contours[p.outer + 1] as number
        let count = 0
        for (let i = a; i < b; i++)
          if (inside(o.points, oa, ob, o.points[i * 2] as number, o.points[i * 2 + 1] as number))
            count++
        if (
          count * 2 > b - a &&
          (best < 0 || Math.abs(areas[p.outer] as number) < Math.abs(areas[best] as number))
        )
          best = p.outer
      }
      if (best >= 0) byOuter.get(best)?.holes.push(h)
      // Wound against the glyph but inside nothing: under the non-zero rule it still fills.
      else polys.push({ outer: h, holes: [] })
    }
    for (const p of polys) {
      flip[p.outer] = (areas[p.outer] as number) < 0
      for (const h of p.holes) flip[h] = (areas[h] as number) > 0
    }
    perGlyph.push(polys)
  }
  return { perGlyph, flip }
}

/** Fill triangles of the outlines (earcut), holes cut from the outer that contains them. */
export const triangulate = (o: Outlines): Fill => fillOf(o, polygonsOf(o).perGlyph)

// A point exactly on an edge's line and strictly between its ends.
const onEdge = (P: Float32Array, u: number, v: number, p: number) => {
  const ux = P[u * 2] as number
  const uy = P[u * 2 + 1] as number
  const dx = (P[v * 2] as number) - ux
  const dy = (P[v * 2 + 1] as number) - uy
  const px = (P[p * 2] as number) - ux
  const py = (P[p * 2 + 1] as number) - uy
  if (dx * py - dy * px !== 0) return false
  const d = dx * px + dy * py
  return d > 0 && d < dx * dx + dy * dy
}

const fillOf = (o: Outlines, perGlyph: Polygon[][]): Fill => {
  const indices: number[] = []
  const glyphs: GlyphRange[] = []
  const P = o.points
  for (const polys of perGlyph) {
    const start = indices.length
    for (const p of polys) {
      const rings = [p.outer, ...p.holes]
      const map: number[] = []
      const data: number[] = []
      const holeAt: number[] = []
      for (const [k, c] of rings.entries()) {
        if (k > 0) holeAt.push(map.length)
        for (let i = o.contours[c] as number; i < (o.contours[c + 1] as number); i++) {
          map.push(i)
          data.push(P[i * 2] as number, P[i * 2 + 1] as number)
        }
      }
      const tris = earcut(data, holeAt.length ? holeAt : null, 2)
      const queue: number[] = []
      for (let t = 0; t < tris.length; t += 3) {
        const a = map[tris[t] as number] as number
        let b = map[tris[t + 1] as number] as number
        let c = map[tris[t + 2] as number] as number
        const ax = P[a * 2] as number
        const ay = P[a * 2 + 1] as number
        const cross =
          ((P[b * 2] as number) - ax) * ((P[c * 2 + 1] as number) - ay) -
          ((P[b * 2 + 1] as number) - ay) * ((P[c * 2] as number) - ax)
        if (cross < 0) [b, c] = [c, b]
        queue.push(a, b, c)
      }
      // earcut lets an ear's edge run straight along vertices lying exactly on it (a hole's edge
      // in line with the diagonal). Split there, so the cap meets the walls edge to edge.
      while (queue.length) {
        const c = queue.pop() as number
        const b = queue.pop() as number
        const a = queue.pop() as number
        let split = false
        for (const [u, v, w] of [
          [a, b, c],
          [b, c, a],
          [c, a, b],
        ] as const) {
          const p = map.find((p) => p !== u && p !== v && onEdge(P, u, v, p))
          if (p !== undefined) {
            queue.push(u, p, w, p, v, w)
            split = true
            break
          }
        }
        if (!split) indices.push(a, b, c)
      }
    }
    glyphs.push({ start, count: indices.length - start })
  }
  return { positions: new Float32Array(P), indices: new Uint32Array(indices), glyphs }
}

/**
 * The outlines as a closed solid `depth` deep: front cap at z = 0 facing +z, back cap at
 * z = -depth facing -z, and side walls flat-shaded per segment. No bevel.
 */
export const extrude = (o: Outlines, opts: { depth: number }): Solid => {
  const depth = opts.depth
  if (!(depth > 0)) throw new Error(`extrude: depth must be > 0, got ${depth}`)
  const { perGlyph, flip } = polygonsOf(o)
  const fill = fillOf(o, perGlyph)
  const N = o.points.length / 2
  const positions = new Float32Array((2 * N + 4 * N) * 3)
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < N; i++) {
    const x = o.points[i * 2] as number
    const y = o.points[i * 2 + 1] as number
    positions.set([x, y, 0], i * 3)
    normals.set([0, 0, 1], i * 3)
    positions.set([x, y, -depth], (N + i) * 3)
    normals.set([0, 0, -1], (N + i) * 3)
  }
  const indices = new Uint32Array(fill.indices.length * 2 + N * 6)
  const glyphs: GlyphRange[] = []
  let w = 0
  let v = 2 * N
  for (const [gi, g] of o.glyphs.entries()) {
    const start = w
    const range = fill.glyphs[gi] as GlyphRange
    const tris = fill.indices.subarray(range.start, range.start + range.count)
    indices.set(tris, w)
    w += tris.length
    for (let t = 0; t < tris.length; t += 3) {
      indices[w++] = N + (tris[t] as number)
      indices[w++] = N + (tris[t + 2] as number)
      indices[w++] = N + (tris[t + 1] as number)
    }
    for (let c = g.contours[0]; c < g.contours[1]; c++) {
      const a0 = o.contours[c] as number
      const n = (o.contours[c + 1] as number) - a0
      for (let k = 0; k < n; k++) {
        // Walk with the filled side on the left: outward is to the right, (dy, -dx).
        const ia = a0 + (flip[c] ? n - 1 - k : k)
        const ib = a0 + (flip[c] ? (2 * n - 2 - k) % n : (k + 1) % n)
        const ax = o.points[ia * 2] as number
        const ay = o.points[ia * 2 + 1] as number
        const bx = o.points[ib * 2] as number
        const by = o.points[ib * 2 + 1] as number
        const len = Math.hypot(bx - ax, by - ay) || 1
        const nx = (by - ay) / len
        const ny = -(bx - ax) / len
        positions.set([ax, ay, 0, bx, by, 0, ax, ay, -depth, bx, by, -depth], v * 3)
        normals.set([nx, ny, 0, nx, ny, 0, nx, ny, 0, nx, ny, 0], v * 3)
        indices.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], w)
        w += 6
        v += 4
      }
    }
    glyphs.push({ start, count: w - start })
  }
  return { positions, normals, indices, glyphs }
}
