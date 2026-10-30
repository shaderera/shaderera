// analysis-scopes, on synthetic frames of known values. Checked: a grey ramp gives its black and
// white points, an even histogram, a rising waveform and no colour; pure primaries sit at their
// vectorscope angles; a tinted grey gives the tint's sign and size in its band; a half-clipped or
// half-crushed frame gives 50 %; a skin tone gives its angle from the skin-tone line; BT.2020
// changes the luma weights; a 16-bit image reads as its 8-bit values.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scopes } from '../analysis-scopes/src/color/scopes.ts'

type Rgb = readonly [number, number, number]

/** A width × height RGBA frame from a function of the pixel. */
const frame = (width: number, height: number, rgb: (x: number, y: number) => Rgb) => {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([...rgb(x, y), 255], (y * width + x) * 4)
  return { width, height, data }
}
const flat = (c: Rgb) => frame(8, 8, () => c)
const near = (got: number | null, want: number, what: string, eps = 1e-4) =>
  assert.ok(got !== null && Math.abs(got - want) <= eps, `${what}: ${got} is not ${want}`)

/** Hue in degrees from +Cb towards +Cr, as worked by hand from BT.709's Y'CbCr. */
const hue709 = ([r, g, b]: Rgb) => {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const deg = (Math.atan2((r - y) / 1.5748, (b - y) / 1.8556) * 180) / Math.PI
  return deg < 0 ? deg + 360 : deg
}

test('analysis-scopes: a grey ramp has its black and white points, an even histogram and no colour', () => {
  // Columns 0–255, each its own grey, 4 rows.
  const s = scopes(frame(256, 4, (x) => [x, x, x]))
  assert.equal(s.pixels, 1024)
  assert.equal(s.luma, 'bt709')
  for (const c of ['r', 'g', 'b', 'y'] as const) {
    near(s.levels[c].mean, 127.5 / 255, `${c} mean`)
    near(s.levels[c].black, 1 / 255, `${c} black`) // the 0.5th percentile: 1.28 columns in
    near(s.levels[c].white, 254 / 255, `${c} white`)
    near(s.levels[c].clipped, (100 * 6) / 256, `${c} clipped`, 0.01) // 250–255
    near(s.levels[c].crushed, (100 * 6) / 256, `${c} crushed`, 0.01) // 0–5
    assert.deepEqual(s.histogram[c], Array(16).fill(6.25))
  }
  assert.equal(s.histogram.bins, 16)
  // 8 bands of 32 columns: the first holds 0–31, the last 224–255.
  assert.equal(s.waveform.length, 8)
  near(s.waveform[0]?.low ?? null, 1 / 255, 'band 0 low')
  near(s.waveform[0]?.median ?? null, 15 / 255, 'band 0 median')
  near(s.waveform[0]?.high ?? null, 30 / 255, 'band 0 high')
  near(s.waveform[7]?.median ?? null, 239 / 255, 'band 7 median')
  for (let i = 1; i < 8; i++)
    assert.ok((s.waveform[i]?.median ?? 0) > (s.waveform[i - 1]?.median ?? 1), 'the waveform rises')
  assert.deepEqual(s.parade.r, s.waveform)
  assert.deepEqual(s.parade.b, s.waveform)
  for (const band of ['shadows', 'midtones', 'highlights'] as const) {
    assert.equal(s.balance[band]?.rg, 0, `${band} rg`)
    assert.equal(s.balance[band]?.bg, 0, `${band} bg`)
    assert.ok((s.balance[band]?.share ?? 0) > 30, `${band} holds a third`)
  }
  assert.equal(s.vectorscope.hueDeg, null)
  assert.equal(s.vectorscope.cast, 0)
  assert.deepEqual(s.vectorscope.saturation, { mean: 0, std: 0 })
  assert.deepEqual(s.vectorscope.skin, { share: 0, offsetDeg: null })
})

test('analysis-scopes: pure primaries sit at their vectorscope angles', () => {
  const primaries: Record<string, Rgb> = {
    red: [255, 0, 0],
    green: [0, 255, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    cyan: [0, 255, 255],
    magenta: [255, 0, 255],
  }
  // By hand: red 102.9°, green 229.7°, blue 354.8° (BT.709 Y'CbCr).
  near(hue709([1, 0, 0]), 102.9, 'red by hand', 0.06)
  near(hue709([0, 1, 0]), 229.7, 'green by hand', 0.06)
  near(hue709([0, 0, 1]), 354.8, 'blue by hand', 0.06)
  for (const [name, c] of Object.entries(primaries)) {
    const v = scopes(flat(c)).vectorscope
    near(v.hueDeg, hue709([c[0] / 255, c[1] / 255, c[2] / 255]), `${name} hue`, 0.06)
    assert.ok(v.saturation.mean > 0.45 && v.saturation.std === 0, `${name} saturated`)
    near(v.cast, v.saturation.mean, `${name} one colour: its cast is its saturation`)
  }
  near(scopes(flat([255, 0, 0])).levels.y.mean, 0.2126, 'red luma')
  near(scopes(flat([255, 0, 0])).levels.r.mean, 1, 'red channel')
  // Red, green and blue columns: each shows in its own part of the parade.
  const bars = scopes(
    frame(24, 2, (x) => (x < 8 ? [255, 0, 0] : x < 16 ? [0, 255, 0] : [0, 0, 255])),
    { bands: 3 },
  )
  assert.deepEqual(
    bars.parade.r.map((b) => b.median),
    [1, 0, 0],
  )
  assert.deepEqual(
    bars.parade.g.map((b) => b.median),
    [0, 1, 0],
  )
  assert.deepEqual(
    bars.parade.b.map((b) => b.median),
    [0, 0, 1],
  )
})

test('analysis-scopes: a tinted grey gives its balance, sign and size, in its own band', () => {
  const mid = scopes(flat([128, 120, 136])).balance
  near(mid.midtones?.rg ?? null, 8 / 255, 'mid rg')
  near(mid.midtones?.bg ?? null, 16 / 255, 'mid bg')
  assert.equal(mid.midtones?.share, 100)
  assert.equal(mid.shadows, null)
  assert.equal(mid.highlights, null)
  // Blue in the shadows, green and less red in the highlights.
  const split = scopes(frame(8, 8, (x) => (x < 4 ? [20, 20, 28] : [220, 230, 230])))
  near(split.balance.shadows?.bg ?? null, 8 / 255, 'shadow bg')
  near(split.balance.shadows?.rg ?? null, 0, 'shadow rg')
  near(split.balance.highlights?.rg ?? null, -10 / 255, 'highlight rg')
  near(split.balance.highlights?.bg ?? null, 0, 'highlight bg')
  assert.equal(split.balance.midtones, null)
})

test('analysis-scopes: a half-clipped and a half-crushed frame are 50 %', () => {
  const clipped = scopes(frame(8, 8, (x) => (x < 4 ? [255, 255, 255] : [128, 128, 128])))
  for (const c of ['r', 'g', 'b', 'y'] as const) {
    assert.equal(clipped.levels[c].clipped, 50, `${c} clipped`)
    assert.equal(clipped.levels[c].crushed, 0, `${c} crushed`)
  }
  near(clipped.levels.y.white, 1, 'white point')
  near(clipped.levels.y.black, 128 / 255, 'black point')
  // Only red clips: the channel says so, luma does not.
  const red = scopes(frame(8, 8, (x) => (x < 4 ? [255, 60, 60] : [128, 60, 60])))
  assert.equal(red.levels.r.clipped, 50)
  assert.equal(red.levels.g.clipped, 0)
  assert.equal(red.levels.y.clipped, 0)
  const crushed = scopes(frame(8, 8, (_, y) => (y < 4 ? [0, 0, 0] : [128, 128, 128])))
  assert.equal(crushed.levels.y.crushed, 50)
  near(crushed.levels.y.black, 0, 'black point')
  assert.equal(crushed.histogram.y[0], 50)
})

test('analysis-scopes: a skin tone sits a few degrees from the skin-tone line', () => {
  const skin: Rgb = [224, 172, 140]
  const v = scopes(flat(skin)).vectorscope
  assert.equal(v.skin.share, 100)
  const offset = hue709([skin[0] / 255, skin[1] / 255, skin[2] / 255]) - 123
  near(v.skin.offsetDeg, offset, 'offset', 0.06)
  assert.ok(offset > 0 && offset < 10, `${offset}° towards yellow`)
  // A saturated red is not skin, nor is grey.
  assert.equal(scopes(flat([255, 0, 0])).vectorscope.skin.share, 0)
  assert.equal(scopes(flat([128, 128, 128])).vectorscope.skin.share, 0)
})

test('analysis-scopes: BT.2020 luma weights, and 16-bit images', () => {
  const s = scopes(flat([0, 255, 0]), { luma: 'bt2020' })
  assert.equal(s.luma, 'bt2020')
  near(s.levels.y.mean, 0.678, 'green luma')
  const deep = new Uint16Array(8 * 8 * 4).fill(128 * 257)
  const d = scopes({ width: 8, height: 8, bits: 16, data: deep })
  near(d.levels.y.mean, 128 / 255, '16-bit grey')
  assert.throws(() => scopes({ width: 9, height: 8, data: new Uint8Array(8 * 8 * 4) }), /9 × 8/)
})
