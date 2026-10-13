// text-glyph-outlines, headless: copied into a project the way `add` lays it out, a font read through
// a fake host, and the geometry checked for holes, closure and determinism.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'text-glyph-outlines')
rmSync(project, { recursive: true, force: true })
mkdirSync(project, { recursive: true })
for (const item of ['text-glyph-outlines', 'font-ibm-plex-sans', 'font-stix-two-text']) {
  const label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
  }
  for (const f of label.files) cpSync(join(plugins, item, f), join(project, f))
}
const { extrude, glyphOutlines, loadFont, triangulate } = (await import(
  pathToFileURL(join(project, 'src/type/outlines.ts')).href
)) as typeof import('../text-glyph-outlines/src/type/outlines.ts')
type Outlines = import('../text-glyph-outlines/src/type/outlines.ts').Outlines

const host = {
  io: { read: async (p: string) => new Uint8Array(readFileSync(join(project, p))) },
} as unknown as Host
const font = await loadFont(host, 'assets/fonts/IBMPlexSans-Regular.ttf')

const ringArea = (o: Outlines, c: number) => {
  let s = 0
  const a = o.contours[c] as number
  const b = o.contours[c + 1] as number
  for (let i = a; i < b; i++) {
    const j = i + 1 < b ? i + 1 : a
    s += (o.points[i * 2] as number) * (o.points[j * 2 + 1] as number)
    s -= (o.points[j * 2] as number) * (o.points[i * 2 + 1] as number)
  }
  return s / 2
}

/** Signed areas of 2D triangles: all must be counter-clockwise. */
const fillArea = (pos: Float32Array, idx: Uint32Array, dim = 2, from = 0, to = idx.length) => {
  let sum = 0
  for (let t = from; t < to; t += 3) {
    const [a, b, c] = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number]
    const ax = pos[a * dim] as number
    const ay = pos[a * dim + 1] as number
    const cross =
      ((pos[b * dim] as number) - ax) * ((pos[c * dim + 1] as number) - ay) -
      ((pos[b * dim + 1] as number) - ay) * ((pos[c * dim] as number) - ax)
    assert.ok(cross >= 0, 'a triangle is wound clockwise')
    sum += cross / 2
  }
  return sum
}

/** Reverses every contour: CFF fonts wind the other way from TrueType. */
const reversed = (o: Outlines): Outlines => {
  const points = new Float32Array(o.points.length)
  for (let c = 0; c + 1 < o.contours.length; c++) {
    const a = o.contours[c] as number
    const b = o.contours[c + 1] as number
    for (let i = a; i < b; i++) {
      points[i * 2] = o.points[(b - 1 - (i - a)) * 2] as number
      points[i * 2 + 1] = o.points[(b - 1 - (i - a)) * 2 + 1] as number
    }
  }
  return { ...o, points }
}

/**
 * Every directed edge (by position, since walls have their own vertices) is met once by its
 * reverse: closed, and wound one way throughout.
 */
const assertClosed = (pos: Float32Array, idx: Uint32Array) => {
  const key = (i: number) => `${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}`
  const edges = new Map<string, number>()
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const k = `${key(idx[t + e] as number)}>${key(idx[t + ((e + 1) % 3)] as number)}`
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
  for (const [k, n] of edges) {
    const [a, b] = k.split('>')
    assert.equal(n, 1, `edge ${k} used ${n} times one way`)
    assert.equal(edges.get(`${b}>${a}`), 1, `edge ${k} has no partner`)
  }
}

test('text-glyph-outlines: "O" is two contours and its fill has a hole', () => {
  const o = glyphOutlines(font, 'O')
  assert.equal(o.contours.length - 1, 2)
  const [outer, inner] = [Math.abs(ringArea(o, 0)), Math.abs(ringArea(o, 1))].sort((a, b) => b - a)
  assert.ok(outer && inner && inner > 0.2 * outer)
  for (const v of [o, reversed(o)]) {
    const f = triangulate(v)
    const filled = fillArea(f.positions, f.indices)
    assert.ok(Math.abs(filled - (outer - inner)) < 0.01 * (outer - inner), `${filled}`)
  }
  assert.ok(o.glyphs[0]?.commands.some((c) => c.type === 'Q'))
})

test('text-glyph-outlines: holes in A, B, 8, and a word of nine glyphs', () => {
  for (const ch of ['A', 'B', '8', 'e', '%']) {
    const o = glyphOutlines(font, ch)
    let expect = 0
    for (let c = 0; c + 1 < o.contours.length; c++) expect += ringArea(o, c)
    const f = triangulate(o)
    assert.ok(
      Math.abs(fillArea(f.positions, f.indices) - Math.abs(expect)) < 0.01 * Math.abs(expect),
    )
  }
  const o = glyphOutlines(font, 'SHADERERA', { size: 2, letterSpacing: 0.05 })
  assert.equal(o.glyphs.length, 9)
  for (let i = 1; i < 9; i++) {
    const [a, b] = [o.glyphs[i - 1], o.glyphs[i]]
    assert.ok(a && b && b.x > a.x && a.advance > 0)
    assert.equal(a.contours[1], b.contours[0])
  }
  assert.ok(Math.abs(o.width - ((o.glyphs[8]?.x ?? 0) + (o.glyphs[8]?.advance ?? 0))) < 1e-9)
  const f = triangulate(o)
  const n = f.positions.length / 2
  assert.ok(f.indices.every((i) => i < n))
  assert.equal(f.glyphs.length, 9)
  for (const g of f.glyphs)
    assert.ok(fillArea(f.positions, f.indices, 2, g.start, g.start + g.count) > 0)
  assert.ok(fillArea(f.positions, f.indices) > 0)
  // Kerning off moves A and V apart.
  const kern = glyphOutlines(font, 'AV').glyphs[1]?.x ?? 0
  const flat = glyphOutlines(font, 'AV', { kerning: false }).glyphs[1]?.x ?? 0
  assert.ok(kern < flat)
})

test('text-glyph-outlines: extrusion is a closed solid', () => {
  const depth = 0.2
  for (const text of ['O', 'B', '8', 'SHADERERA']) {
    const o = glyphOutlines(font, text)
    const s = extrude(o, { depth })
    const N = o.points.length / 2
    const T = triangulate(o).indices.length
    assert.equal(s.positions.length, 6 * N * 3)
    assert.equal(s.normals.length, s.positions.length)
    assert.equal(s.indices.length, 2 * T + 6 * N)
    assert.ok(s.indices.every((i) => i < s.positions.length / 3))
    for (let i = 0; i < s.normals.length; i += 3)
      assert.ok(
        Math.abs(Math.hypot(s.normals[i] ?? 0, s.normals[i + 1] ?? 0, s.normals[i + 2] ?? 0) - 1) <
          1e-5,
      )
    assertClosed(s.positions, s.indices)
    assert.equal(
      s.glyphs.reduce((a, g) => a + g.count, 0),
      s.indices.length,
    )
  }
  assertClosed(
    extrude(reversed(glyphOutlines(font, 'O')), { depth }).positions,
    extrude(reversed(glyphOutlines(font, 'O')), { depth }).indices,
  )
})

test('text-glyph-outlines: same inputs, same bytes; a variable font follows its axes', async () => {
  const run = () => {
    const o = glyphOutlines(font, 'SHADERERA', { size: 3, tolerance: 0.002 })
    return [
      o.points,
      o.contours,
      triangulate(o).indices,
      ...Object.values(extrude(o, { depth: 1 })),
    ]
  }
  const [a, b] = [run(), run()]
  for (const [i, x] of a.entries()) {
    const y = b[i]
    if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y))
      assert.ok(Buffer.from(x.buffer).equals(Buffer.from(y.buffer)))
  }
  const coarse = glyphOutlines(font, 'O', { tolerance: 0.01 }).points.length
  const fine = glyphOutlines(font, 'O', { tolerance: 0.0001 }).points.length
  assert.ok(fine > coarse)
  const stix = await loadFont(host, 'assets/fonts/STIXTwoText[wght].ttf')
  const light = glyphOutlines(stix, 'O', { variation: { wght: 400 } })
  const bold = glyphOutlines(stix, 'O', { variation: { wght: 700 } })
  const ink = (o: Outlines) => {
    const f = triangulate(o)
    return fillArea(f.positions, f.indices)
  }
  assert.ok(ink(bold) > ink(light) * 1.1)
})
