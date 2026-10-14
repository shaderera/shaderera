// look-paper-edges, headless: copied into a project the way `add` lays it out, pieces built on
// @napi-rs/canvas as the Node host builds them, and their pixels checked.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Canvas } from '@napi-rs/canvas'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'look-paper-edges')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'look-paper-edges', 'shaderera.item.json'), 'utf8'),
) as {
  files: string[]
}
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'look-paper-edges', f), join(project, f))
}
const { cutout, PAPERS, strip } = (await import(
  pathToFileURL(join(project, 'src/looks/paper.ts')).href
)) as typeof import('../look-paper-edges/src/looks/paper.ts')
type Piece = import('../look-paper-edges/src/looks/paper.ts').Piece

const io = { canvas: (w: number, h: number) => new Canvas(w, h) as unknown as OffscreenCanvas }
const RED = [200, 20, 20] as const
const red = () => RED

/** A piece's pixels, read at raster coordinates (the margin taken into account). */
const read = (piece: Piece) => {
  const c = piece.canvas
  const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
  const px = new Uint8Array(g.getImageData(0, 0, c.width, c.height).data)
  const at = (x: number, y: number) => ((y + piece.margin) * c.width + x + piece.margin) * 4
  return {
    px,
    alpha: (x: number, y: number) => px[at(x, y) + 3] as number,
    rgb: (x: number, y: number) => [px[at(x, y)], px[at(x, y) + 1], px[at(x, y) + 2]],
  }
}
/** No tone, fibre or cut face: the shape's geometry alone. */
const FLAT = { shade: 0, grain: 0, edgeShade: 0 }
const isPaper = (rgb: (number | undefined)[]) =>
  (rgb[0] as number) > 225 && (rgb[1] as number) > 220 && (rgb[2] as number) > 210

/** A w×h alpha from a test of each pixel's centre. */
const shapeOf = (w: number, h: number, inside: (x: number, y: number) => boolean) => {
  const a = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) a[y * w + x] = 255
  return a
}
const disc = (cx: number, cy: number, r: number) => (x: number, y: number) =>
  (x - cx) ** 2 + (y - cy) ** 2 < r * r

/** 60×40: a disc of radius 15 at (30, 20), and a one-pixel speck at (2, 2). */
const W = 60
const H = 40
const speckled = shapeOf(
  W,
  H,
  (x, y) => disc(30, 20, 15)(x, y) || (x < 3 && x > 2 && y < 3 && y > 2),
)

test('look-paper-edges: with no border the cut is the mask itself, speck and soft edge kept', () => {
  const soft = new Uint8Array(speckled)
  soft[20 * W + 15] = 100 // a soft fringe pixel just outside the disc
  const p = read(cutout(io, { width: W, height: H, alpha: soft, print: red }))
  assert.equal(p.alpha(30, 20), 255)
  assert.deepEqual(p.rgb(30, 20), [200, 20, 20])
  assert.equal(p.alpha(2, 2), 255, 'the speck is cut too')
  assert.equal(p.alpha(15, 20), 100, 'the soft edge stays soft')
  assert.equal(p.alpha(30, 2), 0)
})

test('look-paper-edges: a paper border, around every piece or only the largest', () => {
  const o = {
    width: W,
    height: H,
    alpha: speckled,
    print: red,
    border: 4,
    wobble: 0,
    seed: 3,
    ...FLAT,
  }
  const all = read(cutout(io, o))
  assert.deepEqual(all.rgb(30, 20), [200, 20, 20], 'the print inside')
  assert.equal(all.alpha(47, 20), 255, '2 px past the disc: paper')
  assert.ok(isPaper(all.rgb(47, 20)))
  assert.equal(all.alpha(52, 20), 0, 'nothing past the border')
  assert.equal(all.alpha(4, 2), 255, 'the speck has its own paper')
  const largest = read(cutout(io, { ...o, pieces: 'largest' }))
  assert.equal(largest.alpha(2, 2), 0, 'the speck stays behind')
  assert.equal(largest.alpha(4, 2), 0)
  const big = read(cutout(io, { ...o, pieces: { minArea: 2 } }))
  assert.equal(big.alpha(2, 2), 0, 'pieces under 2 px² stay behind')
  assert.deepEqual(read(cutout(io, o)).px, all.px, 'the same piece from the same seed')
})

test('look-paper-edges: an empty mask is an empty piece, with or without a border', () => {
  const none = new Uint8Array(W * H)
  for (const o of [
    {},
    { border: 6 },
    { border: 6, pieces: 'largest' as const, holes: 'fill' as const },
  ]) {
    const p = read(cutout(io, { width: W, height: H, alpha: none, print: red, ...o }))
    assert.ok(
      p.px.every((v, i) => i % 4 !== 3 || v === 0),
      JSON.stringify(o),
    )
  }
})

test('look-paper-edges: holes are kept, filled, or filled up to a size', () => {
  // A ring: radius 16 with a hole of radius 6, and a pinhole of one pixel in the ring.
  const ring = shapeOf(W, H, (x, y) => disc(30, 20, 16)(x, y) && !disc(30, 20, 6)(x, y))
  ring[20 * W + 41] = 0
  const base = { width: W, height: H, alpha: ring, print: red, ...FLAT }
  const kept = read(cutout(io, base))
  assert.equal(kept.alpha(30, 20), 0)
  assert.equal(kept.alpha(41, 20), 0)
  const filled = read(cutout(io, { ...base, holes: 'fill' }))
  assert.deepEqual(filled.rgb(30, 20), [200, 20, 20])
  assert.equal(filled.alpha(41, 20), 255)
  const small = read(cutout(io, { ...base, holes: { maxArea: 4 } }))
  assert.equal(small.alpha(41, 20), 255, 'the pinhole is filled')
  assert.equal(small.alpha(30, 20), 0, 'the big hole is kept')
  // With a paper border, a kept hole wider than the border shows paper round it and air inside.
  const papered = read(cutout(io, { ...base, border: 2, wobble: 0 }))
  assert.equal(papered.alpha(30, 20), 0)
  assert.ok(isPaper(papered.rgb(30, 25)))
})

test('look-paper-edges: smooth cuts away whiskers thinner than twice its radius', () => {
  // The disc with a 2 px whisker running right from its edge to the raster's edge.
  const whiskered = shapeOf(W, H, (x, y) => disc(30, 20, 15)(x, y) || (x > 44 && y > 19 && y < 21))
  const base = { width: W, height: H, alpha: whiskered, print: red, border: 3, wobble: 0 }
  assert.equal(read(cutout(io, base)).alpha(56, 20), 255, 'the whisker has paper')
  const smooth = read(cutout(io, { ...base, smooth: 2 }))
  assert.equal(smooth.alpha(56, 20), 0, 'the whisker is gone')
  assert.deepEqual(smooth.rgb(30, 20), [200, 20, 20], 'the disc stays')
})

test('look-paper-edges: torn out around a shape, with the print going on to the tear', () => {
  const alpha = shapeOf(W, H, disc(30, 20, 12))
  const print = (x: number) => (x < 30 ? RED : ([20, 20, 200] as const))
  const o = {
    width: W,
    height: H,
    alpha,
    print,
    border: 5,
    edge: 'torn' as const,
    depth: 3,
    rim: 2,
    seed: 4,
    ...FLAT,
  }
  const paper = read(cutout(io, o))
  assert.ok(
    isPaper(paper.rgb(30, 20 - 12 - 4)) || paper.alpha(30, 20 - 12 - 4) === 0,
    'a white border',
  )
  // The tear wanders: how far the piece reaches to the right differs from row to row.
  const reach = new Set<number>()
  for (let y = 12; y < 28; y++) {
    let x = 59
    while (x > 30 && paper.alpha(x, y) === 0) x--
    reach.add(x)
  }
  assert.ok(reach.size > 2, `the tear wanders (${[...reach].join(',')})`)
  const printed = read(cutout(io, { ...o, around: 'print' }))
  assert.deepEqual(printed.rgb(44, 20), [20, 20, 200], 'past the shape, the print goes on')
  assert.notDeepEqual(read(cutout(io, { ...o, seed: 5 })).px, paper.px)
})

test('look-paper-edges: feather fades the print in from its edge', () => {
  const p = read(
    cutout(io, {
      width: W,
      height: H,
      alpha: shapeOf(W, H, disc(30, 20, 15)),
      print: red,
      feather: 6,
    }),
  )
  assert.equal(p.alpha(30, 20), 255)
  const edge = p.alpha(30 + 13, 20)
  assert.ok(edge > 0 && edge < 255, `partly there near the edge (${edge})`)
  assert.equal(p.alpha(30 + 16, 20), 0)
})

test('look-paper-edges: a strip cut straight on its long sides and torn at its ends', () => {
  const o = {
    width: 200,
    height: 50,
    print: red,
    sides: { left: 'torn', right: 'torn', top: 'cut', bottom: 'cut' } as const,
    depth: 6,
    rim: 4,
    seed: 2,
    ...FLAT,
  }
  const piece = strip(io, o)
  const p = read(piece)
  for (const x of [40, 100, 160]) {
    assert.equal(p.alpha(x, 0), 255)
    assert.equal(p.alpha(x, 49), 255)
    assert.equal(p.alpha(x, -1), 0)
    assert.equal(p.alpha(x, 50), 0)
  }
  let core = 0
  const ends = new Set<number>()
  for (let y = 2; y < 48; y++) {
    let x = -piece.margin
    while (x < 30 && p.alpha(x, y) === 0) x++
    ends.add(x)
    if (isPaper(p.rgb(x, y))) core++
  }
  assert.ok(ends.size > 3, `the torn end wanders (${[...ends].join(',')})`)
  assert.ok(core > 30, `white core shows at the tear (${core} of 46 rows)`)
  assert.deepEqual(read(strip(io, o)).px, p.px)
  assert.notDeepEqual(read(strip(io, { ...o, seed: 5 })).px, p.px)
})

test('look-paper-edges: sizes and scales that cannot be built say so', () => {
  const sides = { left: 'cut', right: 'cut', top: 'cut', bottom: 'cut' } as const
  assert.throws(
    () => cutout(io, { width: W, height: H, alpha: new Uint8Array(5), print: red }),
    /alpha has 5 values, not width × height = 2400/,
  )
  assert.throws(
    () => cutout(io, { width: 10.5, height: 4, alpha: new Uint8Array(42), print: red }),
    /width must be a whole number/,
  )
  assert.throws(
    () => strip(io, { width: 0, height: 4, print: red, sides }),
    /width must be a whole number of pixels, at least 1/,
  )
  assert.throws(
    () => strip(io, { width: 4, height: 4, print: red, sides, scale: 0 }),
    /scale must be above 0/,
  )
})

test('look-paper-edges: scissors cut straight snips, and fill the holes they cannot reach', () => {
  // A square stays square: its outline is four straight snips.
  const square = shapeOf(W, H, (x, y) => x > 10 && x < 50 && y > 5 && y < 35)
  const sq = read(
    cutout(io, { width: W, height: H, alpha: square, print: red, edge: 'scissors', ...FLAT }),
  )
  for (const [x, y] of [
    [12, 7],
    [47, 7],
    [12, 33],
    [47, 33],
    [30, 20],
  ] as const)
    assert.equal(sq.alpha(x, y), 255, `inside the square at ${x}, ${y}`)
  assert.equal(sq.alpha(30, 2), 0)
  // A disc becomes a polygon: fewer, straighter edge pixels than a knife's curve, but not the same.
  const round = shapeOf(W, H, disc(30, 20, 15))
  const o = { width: W, height: H, alpha: round, print: red, border: 5, seed: 2, ...FLAT }
  const knife = read(cutout(io, o))
  const snips = read(cutout(io, { ...o, edge: 'scissors', snip: 3 }))
  assert.notDeepEqual(snips.px, knife.px)
  assert.ok(isPaper(snips.rgb(30 + 18, 20)), 'paper round the disc')
  // A ring's hole is out of the scissors' reach: it is filled with paper.
  const ring = shapeOf(W, H, (x, y) => disc(30, 20, 16)(x, y) && !disc(30, 20, 6)(x, y))
  const holed = read(
    cutout(io, {
      width: W,
      height: H,
      alpha: ring,
      print: red,
      border: 2,
      edge: 'scissors',
      ...FLAT,
    }),
  )
  assert.equal(holed.alpha(30, 20), 255)
  assert.deepEqual(
    read(cutout(io, { ...o, edge: 'scissors', snip: 3 })).px,
    snips.px,
    'the same snips from the same seed',
  )
})

test('look-paper-edges: the paper has a stock, a tone, fibre and a darker cut face', () => {
  const alpha = shapeOf(W, H, disc(30, 20, 8))
  const base = { width: W, height: H, alpha, print: red, border: 8, wobble: 0 }
  const kraft = read(cutout(io, { ...base, paper: PAPERS.kraft, ...FLAT }))
  assert.deepEqual(kraft.rgb(30 + 12, 20), [...PAPERS.kraft], 'flat kraft paper')
  // The cut face: the outermost paper is darker than the paper a few px inside it.
  const faced = read(cutout(io, { ...base, shade: 0, grain: 0, edgeShade: 0.4 }))
  let edge = 30 + 8
  while (faced.alpha(edge + 1, 20) > 127) edge++
  assert.ok(
    (faced.rgb(edge, 20)[0] as number) < (faced.rgb(edge - 4, 20)[0] as number) - 20,
    'a darker edge',
  )
  // Tone and fibre: the paper is not one flat colour.
  const toned = read(cutout(io, { ...base, edgeShade: 0 }))
  const reds = new Set<number>()
  for (let y = 14; y < 26; y++) for (let x = 40; x < 46; x++) reds.add(toned.rgb(x, y)[0] as number)
  assert.ok(reds.size > 3, `the paper's colour wanders (${[...reds].join(',')})`)
  // A feathered piece lays into the photo: no darker face at its fading edge.
  const feathered = read(cutout(io, { width: W, height: H, alpha, print: red, feather: 4 }))
  const faded = feathered.rgb(30 + 6, 20)
  assert.ok(feathered.alpha(30 + 6, 20) < 255, 'the edge is fading')
  assert.ok(
    faded.every((v, c) => Math.abs((v as number) - (RED[c] as number)) <= 2),
    `the print's own colour, not darkened (${faded.join(',')})`,
  )
})

test('look-paper-edges: amounts out of range say so', () => {
  const base = { width: W, height: H, alpha: speckled, print: red }
  assert.throws(() => cutout(io, { ...base, border: Number.NaN }), /border must be 0 or more/)
  assert.throws(() => cutout(io, { ...base, border: -2 }), /border must be 0 or more/)
  assert.throws(() => cutout(io, { ...base, wobble: 2 }), /wobble must be from 0 to 1/)
  assert.throws(() => cutout(io, { ...base, edge: 'scissors', snip: 0 }), /snip must be above 0/)
  assert.throws(() => cutout(io, { ...base, edgeShade: 1.5 }), /edgeShade must be from 0 to 1/)
})
