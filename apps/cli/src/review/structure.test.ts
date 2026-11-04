import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodeImage } from '../runner/image.ts'
import {
  edges,
  everywhere,
  heatMap,
  luma,
  type Mask,
  maskedMax,
  maskedMean,
  SSIM,
  sobel,
  ssim,
} from './structure.ts'

// fixtures/ssim: three 96×72 RGB PNGs. a is a poster-like frame (a block, a disc, strokes like
// type, noise); b is a with the strokes moved 2 px, blurred, the block another colour and more
// noise; c is noise. The expected values come from scikit-image 0.24.0 (scipy 1.13.1) on luma
// 0.2126 R + 0.7152 G + 0.0722 B in float64:
//   structural_similarity(x, y, gaussian_weights=True, sigma=1.5, use_sample_covariance=False,
//                         data_range=255, full=True)
// and the edge score from scipy.ndimage.sobel(mode='reflect') along both axes, hypot, then
// Σ w·2·min(a, b) / Σ w·(a + b). Masks: box is 255 over rows 10–29, columns 8–39 (the block);
// soft is 128 over rows 40–71 and 255 over rows 48–63 (the strokes), every column.
const EXPECTED = {
  ab: {
    ssim: 0.6829874172870474,
    box: 0.6280939304766568,
    soft: 0.6096757474136367,
    edges: 0.6440620483686528,
    edgesBox: 0.5117375820897843,
    edgesSoft: 0.5875367918056185,
    meanA: 60.01215611961305,
    meanB: 56.28661632013826,
    at00: 0.7550232730101922,
    at2030: 0.6749519522393723,
  },
  ac: {
    ssim: 0.0203401732571258,
    box: 0.001387268692837959,
    soft: 0.024478387887966222,
    edges: 0.27662670165996656,
    edgesBox: 0.2837694516840647,
    edgesSoft: 0.3207790661705314,
    meanA: 60.01215611961305,
    meanB: 163.4012115518913,
    at00: 0.03738068406423416,
    at2030: 0.033944679931629584,
  },
  bc: {
    ssim: 0.025800871410792063,
    box: 0.022483302018804493,
    soft: 0.022906522463586734,
    edges: 0.37781058103521836,
    edgesBox: 0.3615431140735882,
    edgesSoft: 0.4127025270814599,
    meanA: 56.28661632013826,
    meanB: 163.4012115518913,
    at00: 0.06748867296462024,
    at2030: 0.11094566313006228,
  },
} as const

const W = 96
const H = 72

const fixture = (name: string) => {
  const path = new URL(`./fixtures/ssim/${name}.png`, import.meta.url)
  const img = decodeImage(readFileSync(path), name)
  assert.deepEqual([img.width, img.height, img.bits], [W, H, 8])
  return luma(img.data as Uint8Array)
}

/** A mask over every column of rows, with one coverage a row. */
const rows = (cover: (y: number) => number): Mask => {
  const coverage = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) coverage.fill(cover(y), y * W, (y + 1) * W)
  return { x: 0, y: 0, width: W, height: H, coverage }
}
const BOX: Mask = {
  x: 8,
  y: 10,
  width: 32,
  height: 20,
  coverage: new Uint8Array(32 * 20).fill(255),
}
const SOFT = rows((y) => (y >= 48 && y < 64 ? 255 : y >= 40 ? 128 : 0))

const near = (actual: number | null, expected: number, what: string, within = 1e-9) =>
  assert.ok(
    actual !== null && Math.abs(actual - expected) <= within,
    `${what}: ${actual}, scikit-image ${expected}`,
  )

test('ssim matches scikit-image structural_similarity on the fixtures (#665)', () => {
  const L = { a: fixture('a'), b: fixture('b'), c: fixture('c') }
  for (const [pair, e] of Object.entries(EXPECTED)) {
    const x = L[pair[0] as 'a']
    const y = L[pair[1] as 'b']
    const s = ssim(x, y, W, H)
    // The ticket's bar is 1e-3; the same arithmetic in float64 gives far closer.
    near(s.mean, e.ssim, `${pair} mean`, 1e-9)
    near(s.map[0] as number, e.at00, `${pair} S[0, 0], reflected at the corner`)
    near(s.map[20 * W + 30] as number, e.at2030, `${pair} S[20, 30]`)
    // A region's SSIM: the map's mean weighted by its coverage.
    near(maskedMean(s.map, W, BOX), e.box, `${pair} over the box`)
    near(maskedMean(s.map, W, SOFT), e.soft, `${pair} over the soft mask`)
    // Symmetric, and 1 against itself.
    near(ssim(y, x, W, H).mean, e.ssim, `${pair} reversed`)
    near(ssim(x, x, W, H).mean, 1, `${pair[0]} with itself`)
  }
})

test('the edge score matches scipy Sobel magnitudes, whole and over masks (#665)', () => {
  const L = { a: fixture('a'), b: fixture('b'), c: fixture('c') }
  for (const [pair, e] of Object.entries(EXPECTED)) {
    const ga = sobel(L[pair[0] as 'a'], W, H)
    const gb = sobel(L[pair[1] as 'b'], W, H)
    const whole = edges(ga, gb, W, everywhere(W, H))
    near(whole.agreement, e.edges, `${pair} edges`)
    near(whole.film, e.meanA, `${pair} film's mean magnitude`)
    near(whole.reference, e.meanB, `${pair} reference's mean magnitude`)
    near(edges(ga, gb, W, BOX).agreement, e.edgesBox, `${pair} edges over the box`)
    near(edges(ga, gb, W, SOFT).agreement, e.edgesSoft, `${pair} edges over the soft mask`)
    near(edges(ga, ga, W, everywhere(W, H)).agreement, 1, `${pair[0]} edges with itself`)
  }
})

test('per-region scores: a known mask over the one part that differs (#665)', () => {
  // Two 40×30 grey frames, the same except a bright square at 24–33, 8–17 in one of them.
  const w = 40
  const h = 30
  const flat = new Float64Array(w * h).fill(100)
  const marked = Float64Array.from(flat)
  for (let y = 8; y < 18; y++) for (let x = 24; x < 34; x++) marked[y * w + x] = 220
  const s = ssim(flat, marked, w, h)
  const left: Mask = {
    x: 0,
    y: 0,
    width: 12,
    height: h,
    coverage: new Uint8Array(12 * h).fill(255),
  }
  const square: Mask = {
    x: 24,
    y: 8,
    width: 10,
    height: 10,
    coverage: new Uint8Array(100).fill(255),
  }
  // Far from the square, the window sees the same grey on both sides: SSIM exactly 1.
  assert.equal(maskedMean(s.map, w, left), 1)
  const inside = maskedMean(s.map, w, square) as number
  assert.ok(inside < 0.5, `SSIM over the square ${inside}`)
  // Half coverage over the left counts the same as full: a weighted mean, not a sum.
  const half: Mask = { ...left, coverage: new Uint8Array(12 * h).fill(128) }
  assert.equal(maskedMean(s.map, w, half), 1)
  // Both sides flat: no edges, so no edge score, rather than a number from 0 / 0.
  const g0 = sobel(flat, w, h)
  const g1 = sobel(marked, w, h)
  assert.equal(edges(g0, g1, w, left).agreement, null)
  // Over the square's outline only the marked side has edges: they agree on none.
  assert.equal(edges(g0, g1, w, square).agreement, 0)
  assert.equal(maskedMax(s.map, w, left), 1)
  const none: Mask = { ...left, coverage: new Uint8Array(12 * h) }
  assert.equal(maskedMean(s.map, w, none), null)
  assert.equal(maskedMax(s.map, w, none), null)
})

test('ssim refuses a frame smaller than its window', () => {
  const p = new Float64Array(10 * 30)
  assert.throws(() => ssim(p, p, 10, 30), /at least 11×11 pixels/)
  assert.equal(SSIM.size, 11)
})

test('heatMap: black where SSIM is 1, inferno pale yellow at 0 or below', () => {
  const px = heatMap(Float64Array.from([1, 0, -0.5, 0.5]))
  assert.deepEqual([...px.subarray(0, 4)], [0, 0, 4, 255])
  assert.deepEqual([...px.subarray(4, 8)], [252, 255, 164, 255])
  assert.deepEqual([...px.subarray(8, 12)], [252, 255, 164, 255])
  assert.deepEqual([...px.subarray(12, 16)], [188, 55, 84, 255])
})
