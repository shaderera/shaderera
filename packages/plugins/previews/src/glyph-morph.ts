// Morphs between glyph outlines, for the font previews: a glyph's contours (from the
// text-glyph-outlines item) resampled to the same number of points by arc length, matched
// contour to contour (outers with outers, holes with holes, nearest first) and turned so their
// starts agree, so any two shapes lerp. A family is one character in several faces of a typeface
// (Light, Regular, SemiBold; or roman and italic), every face aligned to the first, so a weight
// between two faces is a true in-between. A contour with no partner grows from, or shrinks to, a
// point.

import { type Font, glyphOutlines } from './type/outlines.ts'

/** One closed contour, `n` points as x, y pairs, in ems, y up, the pen at 0. */
export type Ring = Float32Array
/** A character in each face: `rings[slot][face]`, the same slots for every face. */
export type Family = { rings: Ring[][]; advance: number[] }

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
const point = (n: number, [x, y]: [number, number]): Ring => {
  const r = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    r[i * 2] = x
    r[i * 2 + 1] = y
  }
  return r
}

/** A closed polyline resampled to `n` points evenly by arc length. */
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

/** A character's contours in one face, resampled, and its advance. */
export const ringsOf = (font: Font, ch: string, n: number) => {
  const o = glyphOutlines(font, ch, { tolerance: 0.0015, kerning: false })
  const rings: Ring[] = []
  for (let c = 0; c + 1 < o.contours.length; c++)
    rings.push(resample(o.points, o.contours[c] as number, o.contours[c + 1] as number, n))
  return { rings, advance: o.width }
}

/** `b` reversed if it winds against `a`, and turned so its points lie nearest a's. */
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
  // Compared without their offset, so a glyph moving to another place still turns the short way.
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
  pairs.sort((x, y) => x.cost - y.cost)
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

/** `ch` in every face of `fonts`, each face aligned to the first. */
export const familyOf = (fonts: Font[], ch: string, n: number): Family => {
  const faces = fonts.map((f) => ringsOf(f, ch, n))
  const first = faces[0]
  if (!first) throw new Error('familyOf needs at least one font')
  const slots: Ring[][] = first.rings.map((r) => [r])
  for (let w = 1; w < faces.length; w++) {
    const other = faces[w]?.rings ?? []
    const refs = slots.map((s) => s[0] as Ring)
    for (const [i, j] of match(refs, other)) {
      if (i >= 0) {
        const slot = slots[i] as Ring[]
        slot[w] =
          j >= 0 ? align(refs[i] as Ring, other[j] as Ring) : point(n, centroid(refs[i] as Ring))
      } else {
        // A contour the first face lacks: every earlier face grows it from a point.
        const ring = other[j] as Ring
        const c = centroid(ring)
        slots.push([...Array.from({ length: w }, () => point(n, c)), ring])
      }
    }
  }
  return { rings: slots, advance: faces.map((f) => f.advance) }
}

/** The family at face `w` (0 the first; 1.5 half way from the second to the third). */
export const atFace = (f: Family, w: number): { rings: Ring[]; advance: number } => {
  const last = f.advance.length - 1
  const c = Math.min(last, Math.max(0, w))
  const i = Math.min(last - 1, Math.floor(c))
  if (last === 0) return { rings: f.rings.map((s) => s[0] as Ring), advance: f.advance[0] ?? 0 }
  const k = c - i
  return {
    rings: f.rings.map((s) => lerpRing(s[i] as Ring, s[i + 1] as Ring, k)),
    advance: (f.advance[i] ?? 0) * (1 - k) + (f.advance[i + 1] ?? 0) * k,
  }
}

export const lerpRing = (a: Ring, b: Ring, k: number): Ring => {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++)
    out[i] = (a[i] as number) + ((b[i] as number) - (a[i] as number)) * k
  return out
}

/** How two families' slots pair (by their first faces), kept per pair of characters. */
export type Pairing = { pairs: [number, number][]; turn: Map<number, number> }
const pairings = new Map<string, Pairing>()
export const pairingOf = (key: string, a: Family, b: Family): Pairing => {
  const known = pairings.get(key)
  if (known) return known
  const as = a.rings.map((s) => s[0] as Ring)
  const bs = b.rings.map((s) => s[0] as Ring)
  const pairs = match(as, bs)
  // For each pair, how far b's ring turns to meet a's (the same turn serves every face).
  const turn = new Map<number, number>()
  for (const [i, j] of pairs) {
    if (i < 0 || j < 0) continue
    const ra = as[i] as Ring
    const rb = bs[j] as Ring
    const n = ra.length / 2
    const aligned = align(ra, rb)
    // Find which turn of rb gives `aligned` (or its reverse): store it signed.
    const reversed = Math.sign(signedArea(ra)) !== Math.sign(signedArea(rb))
    let s = 0
    for (; s < n; s++) {
      const j0 = reversed ? n - 1 - (s % n) : s % n
      if (rb[j0 * 2] === aligned[0] && rb[j0 * 2 + 1] === aligned[1]) break
    }
    turn.set(j, reversed ? -(s + 1) : s)
  }
  const p = { pairs, turn }
  pairings.set(key, p)
  return p
}

const turned = (r: Ring, t: number): Ring => {
  const n = r.length / 2
  const out = new Float32Array(r.length)
  const reversed = t < 0
  const s = reversed ? -t - 1 : t
  for (let i = 0; i < n; i++) {
    const j = reversed ? (((n - 1 - (i + s)) % n) + n) % n : (i + s) % n
    out[i * 2] = r[j * 2] as number
    out[i * 2 + 1] = r[j * 2 + 1] as number
  }
  return out
}

/**
 * A shape `k` of the way from rings `a` to rings `b` (both at the same face of their families),
 * paired by `p`; b's rings are offset by `dx` ems (where its glyph sits relative to a's).
 */
export const morph = (a: Ring[], b: Ring[], p: Pairing, k: number, dx = 0): Ring[] =>
  p.pairs.map(([i, j]) => {
    const ra = i >= 0 ? (a[i] as Ring) : undefined
    let rb = j >= 0 ? (b[j] as Ring) : undefined
    if (rb && dx !== 0) {
      const moved = new Float32Array(rb)
      for (let q = 0; q < moved.length; q += 2) moved[q] = (moved[q] as number) + dx
      rb = moved
    }
    if (ra && rb) return lerpRing(ra, turned(rb, p.turn.get(j) ?? 0), k)
    if (ra) return lerpRing(ra, point(ra.length / 2, centroid(ra)), k)
    const r = rb as Ring
    return lerpRing(point(r.length / 2, centroid(r)), r, k)
  })

type Ctx = OffscreenCanvasRenderingContext2D

/** Adds the rings to the current path at (x, baseline) and `size` px per em (y flipped). */
export const tracePath = (ctx: Ctx, rings: Ring[], x: number, baseline: number, size: number) => {
  for (const r of rings) {
    const n = r.length / 2
    ctx.moveTo(x + (r[0] as number) * size, baseline - (r[1] as number) * size)
    for (let i = 1; i < n; i++)
      ctx.lineTo(x + (r[i * 2] as number) * size, baseline - (r[i * 2 + 1] as number) * size)
    ctx.closePath()
  }
}

/** Rings in ems at (x, baseline) and `size` px per em, as canvas pixels (y down). */
export const toPixels = (rings: Ring[], x: number, baseline: number, size: number): Ring[] =>
  rings.map((r) => {
    const out = new Float32Array(r.length)
    for (let i = 0; i < r.length; i += 2) {
      out[i] = x + (r[i] as number) * size
      out[i + 1] = baseline - (r[i + 1] as number) * size
    }
    return out
  })

/** Adds rings already in pixels to the current path. */
export const tracePixels = (ctx: Ctx, rings: Ring[]) => {
  for (const r of rings) {
    const n = r.length / 2
    ctx.moveTo(r[0] as number, r[1] as number)
    for (let i = 1; i < n; i++) ctx.lineTo(r[i * 2] as number, r[i * 2 + 1] as number)
    ctx.closePath()
  }
}

/** Where a line of a phrase is set: its left edge (or centre), baseline and size in px per em. */
export type LinePlace = {
  x: number
  baseline: number
  size: number
  align?: 'left' | 'center' | 'right'
}

/**
 * Lines of text that morph, letter into letter, from one phrase to the next every `step` seconds,
 * while each letter sits at its own face (`face`, 0 the first font, 1 the second, between them a
 * true in-between) at every moment. `place` sets a line given its width in ems at size 1.
 */
export const createMorphLines = (o: {
  fonts: Font[]
  phrases: string[][]
  /** Points per contour. */
  n: number
  step: number
  /** How long a letter takes to become the next phrase's letter, and the delay per line and letter. */
  morph: number
  stagger: { line: number; letter: number }
  place: (phrase: number, line: number, widthEm: number) => LinePlace
  face: (t: number, phrase: number, line: number, letter: number) => number
}) => {
  const families = new Map<string, Family>()
  const familyFor = (ch: string) => {
    let f = families.get(ch)
    if (!f) {
      f = familyOf(o.fonts, ch, o.n)
      families.set(ch, f)
    }
    return f
  }
  for (const p of o.phrases) for (const line of p) for (const ch of line) familyFor(ch)
  const empty: Family = { rings: [], advance: o.fonts.map(() => 0) }
  const count = o.phrases.length
  const wrap = (k: number) => ((k % count) + count) % count

  // A line of phrase p at time t: each letter's rings in pixels, with its family.
  const layout = (t: number, p: number, j: number) => {
    const text = [...(o.phrases[p]?.[j] ?? '')]
    const shapes = text.map((ch, i) => ({ ch, ...atFace(familyFor(ch), o.face(t, p, j, i)) }))
    const width = shapes.reduce((s, x) => s + x.advance, 0)
    const at = o.place(p, j, width)
    const start =
      at.align === 'center'
        ? at.x - (width * at.size) / 2
        : at.align === 'right'
          ? at.x - width * at.size
          : at.x
    let pen = 0
    return shapes.map((s) => {
      const px = toPixels(s.rings, start + pen * at.size, at.baseline, at.size)
      pen += s.advance
      return { ch: s.ch, rings: px }
    })
  }

  const lineCount = Math.max(...o.phrases.map((p) => p.length))
  return {
    /** Every letter's outline at t, in pixels, ready to fill. */
    at(t: number) {
      const n = Math.floor(t / o.step)
      const since = t - n * o.step
      const cur = wrap(n)
      const prev = wrap(n - 1)
      const letters: { rings: Ring[]; line: number; index: number; k: number }[] = []
      for (let j = 0; j < lineCount; j++) {
        const b = layout(t, cur, j)
        const a = layout(t, prev, j)
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const raw = (since - j * o.stagger.line - i * o.stagger.letter) / o.morph
          const c = Math.min(1, Math.max(0, raw))
          const k = c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
          const la = a[i]
          const lb = b[i]
          if (k >= 1 || !la) {
            if (lb && k >= 1) letters.push({ rings: lb.rings, line: j, index: i, k: 1 })
            else if (lb) {
              const p = pairingOf(`|${lb.ch}`, empty, familyFor(lb.ch))
              letters.push({ rings: morph([], lb.rings, p, k), line: j, index: i, k })
            }
            continue
          }
          const fb = lb ? familyFor(lb.ch) : empty
          const p = pairingOf(`${la.ch}|${lb?.ch ?? ''}`, familyFor(la.ch), fb)
          letters.push({ rings: morph(la.rings, lb?.rings ?? [], p, k), line: j, index: i, k })
        }
      }
      return { phrase: cur, letters }
    },
  }
}
