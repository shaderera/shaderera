// text-glyph-morph, headless: copied into a project the way `add` lays it out (with the
// text-glyph-outlines it requires), a font read through a fake host, and the morph checked at its
// ends, through a hole that closes, letter by letter, and for determinism.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Canvas } from '@napi-rs/canvas'
import type { Host } from '@shaderera/core'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'text-glyph-morph')
rmSync(project, { recursive: true, force: true })
mkdirSync(project, { recursive: true })
const label = (item: string) =>
  JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
    requires?: { items?: Record<string, string> }
  }
const items = ['text-glyph-morph', ...Object.keys(label('text-glyph-morph').requires?.items ?? {})]
for (const item of [...items, 'font-ibm-plex-sans', 'font-stix-two-text'])
  for (const f of label(item).files) cpSync(join(plugins, item, f), join(project, f))
const { boundsOf, lettersOf, morphLetters, morphOf, shapeOf, tracePath } = (await import(
  pathToFileURL(join(project, 'src/type/glyph-morph.ts')).href
)) as typeof import('../text-glyph-morph/src/type/glyph-morph.ts')
const { loadFont } = (await import(
  pathToFileURL(join(project, 'src/type/outlines.ts')).href
)) as typeof import('../text-glyph-outlines/src/type/outlines.ts')
type Ring = import('../text-glyph-morph/src/type/glyph-morph.ts').Ring
type Morph = import('../text-glyph-morph/src/type/glyph-morph.ts').Morph

const host = {
  io: { read: async (p: string) => new Uint8Array(readFileSync(join(project, p))) },
} as unknown as Host
const font = await loadFont(host, 'assets/fonts/IBMPlexSans-Regular.ttf')

const area = (r: Ring) => {
  let s = 0
  const n = r.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s += (r[i * 2] as number) * (r[j * 2 + 1] as number)
    s -= (r[j * 2] as number) * (r[i * 2 + 1] as number)
  }
  return s / 2
}
const sorted = (rings: Ring[]) => rings.map((r) => Math.abs(area(r))).sort((a, b) => b - a)

test('text-glyph-morph: shapes are resampled rings of one length', () => {
  const o = shapeOf(font, 'O', { points: 120 })
  assert.equal(o.rings.length, 2)
  for (const r of o.rings) assert.equal(r.length, 240)
  assert.ok(o.width > 0.4 && o.width < 1)
  const word = shapeOf(font, 'Bob')
  assert.equal(word.rings.length, 7)
  assert.throws(() => shapeOf(font, 'O', { points: 2 }))
  assert.throws(() => morphOf(shapeOf(font, 'O', { points: 50 }), shapeOf(font, 'O')))
})

test('text-glyph-morph: k 0 is the first shape, k 1 the second; an O closes its hole into an I', () => {
  const a = shapeOf(font, 'O')
  const b = shapeOf(font, 'I')
  const m = morphOf(a, b)
  const start = m.at(0)
  assert.equal(start.rings.length, 2)
  for (const [i, r] of a.rings.entries()) assert.deepEqual(start.rings[i], r)
  assert.equal(start.width, a.width)
  const end = m.at(1)
  assert.equal(end.width, b.width)
  // The I's one contour, and the O's hole shrunk to a point.
  const [big, small] = sorted(end.rings)
  assert.ok(Math.abs((big ?? 0) - Math.abs(area(b.rings[0] as Ring))) < 1e-6)
  assert.equal(small, 0)
  const outer = end.rings.find((r) => Math.abs(area(r)) > 0) as Ring
  assert.deepEqual(boundsOf([outer]), boundsOf(b.rings))
  // Halfway is between the two, and k is clamped.
  const [mid] = sorted(m.at(0.5).rings)
  assert.ok((mid ?? 0) < (sorted(a.rings)[0] ?? 0) && (mid ?? 0) > (big ?? 0) * 0.5)
  assert.deepEqual(m.at(-1).rings, start.rings)
  assert.deepEqual(m.at(2).rings, end.rings)
})

test('text-glyph-morph: letter by letter, the longer word grows from points', () => {
  const a = lettersOf(font, 'AB')
  const b = lettersOf(font, 'xyz')
  assert.equal(a.length, 2)
  const [p0, p1] = lettersOf(font, 'AB', { kerning: false })
  assert.ok((boundsOf(p1?.rings ?? [])?.[0] ?? 0) > (boundsOf(p0?.rings ?? [])?.[0] ?? 0))
  const ms = morphLetters(a, b)
  assert.equal(ms.length, 3)
  const grown = ms[2] as Morph
  assert.deepEqual(grown.at(0).rings.map(area), [0])
  assert.equal(grown.at(0).width, 0)
  assert.deepEqual(boundsOf(grown.at(1).rings), boundsOf(b[2]?.rings ?? []))
  // A weight morph of the same glyph in a variable font.
  return loadFont(host, 'assets/fonts/STIXTwoText[wght].ttf').then((stix) => {
    const w = morphOf(
      shapeOf(stix, 'e', { variation: { wght: 400 } }),
      shapeOf(stix, 'e', { variation: { wght: 700 } }),
    )
    const ink = (k: number) => w.at(k).rings.reduce((s, r) => s + area(r), 0)
    assert.ok(Math.abs(ink(1)) > Math.abs(ink(0)) * 1.1)
    assert.ok(Math.abs(ink(0.5)) > Math.abs(ink(0)) && Math.abs(ink(0.5)) < Math.abs(ink(1)))
  })
})

test('text-glyph-morph: same inputs, same bytes; tracePath fills a canvas', () => {
  const run = () => morphOf(shapeOf(font, 'R&'), shapeOf(font, 'g8')).at(0.37).rings
  const [x, y] = [run(), run()]
  assert.equal(x.length, y.length)
  for (const [i, r] of x.entries())
    assert.ok(Buffer.from(r.buffer).equals(Buffer.from((y[i] as Ring).buffer)))
  const canvas = new Canvas(200, 200)
  const ctx = canvas.getContext('2d')
  ctx.beginPath()
  tracePath(ctx, morphOf(shapeOf(font, 'O'), shapeOf(font, 'I')).at(0.5).rings, {
    x: 40,
    y: 170,
    size: 180,
  })
  ctx.fill('nonzero')
  const d = ctx.getImageData(0, 0, 200, 200).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) n++
  assert.ok(n > 2000, `${n} pixels inked`)
})
