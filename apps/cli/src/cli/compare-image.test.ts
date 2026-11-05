import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { encode } from 'fast-png'
import { tempDir } from '../fixtures/temp.ts'
import { compareWithFile } from './compare-file.ts'
import {
  type CompareImageReport,
  exifOrientation,
  imageFrameLines,
  imageSummaryLines,
} from './compare-image.ts'

const W = 48
const H = 36

/** A dark frame with a yellow 12 px square whose left edge is at 6 + 20·t, at scale s. */
const frame = (t: number, s = 1) => {
  const w = W * s
  const px = new Uint8Array(w * H * s * 4)
  const x0 = Math.round((6 + 20 * t) * s)
  for (let y = 0; y < H * s; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inside = x >= x0 && x < x0 + 12 * s && y >= 12 * s && y < 24 * s
      px.set(inside ? [255, 200, 0, 255] : [20, 30, 60, 255], i)
    }
  return px
}

const film = { width: W, height: H, duration: 2, render: async (t: number) => frame(t) }

/** The film's frame at t written as a PNG, at `s` times its size: a still reference. */
const poster = (dir: string, t: number, s = 1) => {
  const file = join(dir, `poster-${t}-${s}.png`)
  const bytes = encode({ width: W * s, height: H * s, data: frame(t, s), channels: 4, depth: 8 })
  writeFileSync(file, bytes)
  return { file, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const compare = async (o: Partial<Parameters<typeof compareWithFile>[0]> & { reference: string }) =>
  (await compareWithFile({ film, times: [], ...o })) as CompareImageReport

test('--compare-file <image> measures the film still at each time against one image (#665)', async () => {
  const dir = tempDir('compare-image')
  const { file, sha256 } = poster(dir, 1)
  const shown: number[] = []
  const r = await compare({
    reference: file,
    times: [1, 0],
    frame: async (f) => {
      // The film, the image and the SSIM heat map side by side.
      assert.deepEqual([f.width, f.height, f.pixels.length], [W * 3, H, W * 3 * H * 4])
      shown.push(f.t)
    },
  })
  assert.deepEqual(r.reference, {
    kind: 'image',
    file,
    width: W,
    height: H,
    bits: 8,
    sha256,
    alpha: false,
  })
  assert.equal(r.method.matte, 'black')
  assert.equal(r.scaled, null)
  assert.equal(r.regions, null)
  assert.equal(r.method.ssim.sigma, 1.5)
  assert.deepEqual(shown, [0, 1])
  const [at0, at1] = r.frames as [
    CompareImageReport['frames'][number],
    CompareImageReport['frames'][number],
  ]
  // At 1 the film is the image: identical.
  assert.equal(at1.psnr, Number.POSITIVE_INFINITY)
  assert.equal(at1.ssim, 1)
  assert.equal(at1.edges.agreement, 1)
  // At 0 the square is 20 px to the left.
  assert.ok(at0.ssim < 0.9, `SSIM ${at0.ssim}`)
  assert.ok((at0.edges.agreement as number) < 0.5, `edges ${at0.edges.agreement}`)
  assert.ok(at0.deltaE > 0)
  assert.match(imageFrameLines(at1)[0] as string, /identical, .*; SSIM 1\.000, edges 1\.000$/)
  assert.deepEqual(imageSummaryLines(r), [`reference: ${W}×${H} image`])
})

test('--regions with boxes scores each part apart, over the known mask (#665)', async () => {
  const dir = tempDir('compare-image-boxes')
  const { file } = poster(dir, 1)
  const boxes = join(dir, 'boxes.json')
  writeFileSync(
    boxes,
    JSON.stringify({
      width: W,
      height: H,
      boxes: [
        // Where the square is at 1 and is not at 0.
        { name: 'square', x: 26, y: 12, width: 12, height: 12 },
        // A corner the square never reaches, and its windows never see.
        { name: 'corner', x: 0, y: 0, width: 4, height: 4 },
        // Partly outside the frame: counted where it is inside.
        { name: 'edge', x: 40, y: -4, width: 20, height: 8 },
      ],
    }),
  )
  const r = await compare({ reference: file, times: [0, 1], regions: boxes })
  assert.equal(r.regions?.kind, 'boxes')
  assert.deepEqual(r.regions?.in, [W, H])
  assert.deepEqual(
    r.regions?.list.map((q) => [q.id, q.box, q.area]),
    [
      ['square', { x: 26, y: 12, width: 12, height: 12 }, 144],
      ['corner', { x: 0, y: 0, width: 4, height: 4 }, 16],
      ['edge', { x: 40, y: 0, width: 8, height: 4 }, 32],
    ],
  )
  const [at0, at1] = r.frames as [
    CompareImageReport['frames'][number],
    CompareImageReport['frames'][number],
  ]
  const by = (f: typeof at0, id: string) =>
    f.regions.find((q) => q.id === id) as (typeof f.regions)[number]
  // The corner is the same at both times: SSIM 1 and no colour difference.
  for (const f of [at0, at1]) {
    assert.equal(by(f, 'corner').ssim, 1)
    assert.equal(by(f, 'corner').deltaE, 0)
    assert.equal(by(f, 'corner').maxDeltaE, 0)
    assert.equal(by(f, 'corner').edges.agreement, null)
  }
  // The square's place: the background in the film at 0, yellow in the image.
  const square = by(at0, 'square')
  assert.ok(square.ssim < 0.3, `SSIM ${square.ssim}`)
  assert.ok(square.deltaE > 30 && square.maxDeltaE >= square.deltaE)
  assert.equal(by(at1, 'square').ssim, 1)
  // The whole frame scores between the region that differs and the one that does not.
  assert.ok(at0.ssim > square.ssim && at0.ssim < 1)
  const lines = imageFrameLines(at0)
  assert.equal(lines.length, 4)
  assert.match(
    lines[1] as string,
    /^ {2}square: SSIM 0\.\d{3}, edges \d\.\d{3}, mean ΔE \d+\.\d{3} \(max \d+\.\d{2}\)$/,
  )
  assert.match(lines[2] as string, /^ {2}corner: SSIM 1\.000, no edges, mean ΔE 0\.000/)
  assert.match(
    imageSummaryLines(r)[1] as string,
    /^regions: square, corner, edge \(boxes in 48×36\)$/,
  )
})

test('--regions reads a regions artifact of the image, its u8 masks scaled to the frame (#665)', async () => {
  const dir = tempDir('compare-image-artifact')
  // The image at twice the film's size: it and its regions are scaled to the frame once.
  const { file, sha256 } = poster(dir, 1, 2)
  const folder = join(dir, 'regions', 'poster')
  mkdirSync(folder, { recursive: true })
  // The square's mask at 2×: 24×24 at 52,24, every byte 255.
  writeFileSync(join(folder, 'square-0.u8'), new Uint8Array(24 * 24).fill(255))
  const mask = {
    file: 'square-0.u8',
    dtype: 'u8',
    channels: 1,
    width: 24,
    height: 24,
    rowStride: 24,
    at: [52, 24],
  }
  const doc = {
    format: 'shaderera.analysis/1',
    kind: 'regions',
    source: { path: 'poster.png', bytes: 0, sha256, width: W * 2, height: H * 2 },
    tool: { script: 'test' },
    params: {},
    regions: [
      {
        id: 'square-0',
        label: 'square',
        score: 1,
        box: { x: 52, y: 24, width: 24, height: 24 },
        centre: [64, 36],
        mask,
      },
    ],
  }
  const write = (d: object) => writeFileSync(join(folder, 'regions.json'), JSON.stringify(d))
  write(doc)
  const r = await compare({ reference: file, times: [0, 1], regions: folder })
  assert.deepEqual(r.scaled, {
    from: [W * 2, H * 2],
    to: [W, H],
    filter: 'triangle',
    aspect: 'same',
  })
  assert.equal(r.regions?.kind, 'regions')
  assert.equal(r.regions?.file, join(folder, 'regions.json'))
  assert.deepEqual(r.regions?.in, [W * 2, H * 2])
  const [q] = r.regions?.list ?? []
  assert.equal(q?.id, 'square-0')
  assert.equal(q?.label, 'square')
  // The triangle filter softens the mask's edge by a pixel: the box takes it in, the area is 12².
  assert.deepEqual(q?.box, { x: 25, y: 11, width: 14, height: 14 })
  assert.ok(Math.abs((q?.area as number) - 144) < 1, `area ${q?.area}`)
  // Scaled from 2×, the square in the image is a little softer than the film's.
  assert.ok((r.frames[1]?.regions[0]?.ssim as number) > 0.9)
  assert.ok((r.frames[0]?.regions[0]?.ssim as number) < 0.5)

  // Refused: another image's regions, another format, another kind, a mask path out of the folder.
  await assert.rejects(
    compare({ reference: poster(dir, 0, 2).file, times: [0], regions: folder }),
    /measured from other bytes than .*poster-0-2\.png/,
  )
  write({ ...doc, format: 'shaderera.analysis/2' })
  await assert.rejects(
    compare({ reference: file, times: [0], regions: folder }),
    /this shaderera reads shaderera\.analysis\/1/,
  )
  write({ ...doc, kind: 'reference-tracks' })
  await assert.rejects(
    compare({ reference: file, times: [0], regions: folder }),
    /of kind "reference-tracks", not regions/,
  )
  write({ ...doc, regions: [{ ...doc.regions[0], mask: { ...mask, file: '../square-0.u8' } }] })
  await assert.rejects(
    compare({ reference: file, times: [0], regions: folder }),
    /is not a file name/,
  )
  write({ ...doc, regions: [{ ...doc.regions[0], mask: { ...mask, height: 30 } }] })
  await assert.rejects(
    compare({ reference: file, times: [0], regions: folder }),
    /has 576 bytes, not 24 × 30/,
  )
  write({ ...doc, regions: [{ ...doc.regions[0], mask: { ...mask, file: 'gone.u8' } }] })
  await assert.rejects(
    compare({ reference: file, times: [0], regions: folder }),
    /region square-0's mask gone\.u8 could not be read \(ENOENT/,
  )

  // Within a project (MCP), a mask or regions.json linked out of it is refused, not read.
  write(doc)
  const outside = tempDir('compare-image-outside')
  writeFileSync(join(outside, 'square-0.u8'), new Uint8Array(24 * 24).fill(255))
  rmSync(join(folder, 'square-0.u8'))
  symlinkSync(join(outside, 'square-0.u8'), join(folder, 'square-0.u8'))
  assert.equal(
    (await compare({ reference: file, times: [0], regions: folder })).regions?.list.length,
    1,
  )
  await assert.rejects(
    compare({ reference: file, times: [0], regions: folder, within: dir }),
    /mask square-0\.u8 could not be read \(.*outside the project \(through a link\)/,
  )
  writeFileSync(join(outside, 'regions.json'), JSON.stringify(doc))
  const linked = join(dir, 'regions', 'linked')
  mkdirSync(linked)
  symlinkSync(join(outside, 'regions.json'), join(linked, 'regions.json'))
  await assert.rejects(
    compare({ reference: file, times: [0], regions: linked, within: dir }),
    /regions\.json is outside the project \(through a link\)/,
  )
})

test('--compare-file <image> refuses what does not fit a still, saying what to give (#665)', async () => {
  const dir = tempDir('compare-image-refuse')
  const { file } = poster(dir, 1)
  await assert.rejects(compare({ reference: file }), /is a still image: give the film's times/)
  await assert.rejects(
    compare({ reference: file, times: [1], offset: 0.2 }),
    /--offset reads a clip over time/,
  )
  await assert.rejects(
    compare({ reference: file, times: [1], maxShift: 2 }),
    /--max-shift reads a clip/,
  )
  await assert.rejects(compare({ reference: file, times: [3] }), /Outside the film \(0 to 2 s\): 3/)
  const boxes = join(dir, 'boxes.json')
  writeFileSync(
    boxes,
    JSON.stringify({
      width: 100,
      height: 50,
      boxes: [{ name: 'a', x: 0, y: 0, width: 4, height: 4 }],
    }),
  )
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /is in 100×50 pixels: boxes are in the reference's pixels \(48×36\) or the film's \(48×36\)/,
  )
  writeFileSync(boxes, JSON.stringify({ boxes: [{ name: 'a', x: 0, y: 0, width: 4, height: 4 }] }))
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /has boxes without a whole width and height, the pixels they are in: the reference's \(48×36\) or the film's \(48×36\)/,
  )
  writeFileSync(boxes, JSON.stringify({ width: W, height: H }))
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /is neither: give a regions artifact/,
  )
  writeFileSync(
    boxes,
    JSON.stringify({
      width: W,
      height: H,
      boxes: [{ name: 'a', x: 0.5, y: 0, width: 4, height: 4 }],
    }),
  )
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /box a needs a name and x, y, width and height in whole pixels/,
  )
  writeFileSync(
    boxes,
    JSON.stringify({
      width: W,
      height: H,
      boxes: [
        { name: 'a', x: 0, y: 0, width: 4, height: 4 },
        { name: 'a', x: 4, y: 0, width: 4, height: 4 },
      ],
    }),
  )
  await assert.rejects(compare({ reference: file, times: [1], regions: boxes }), /names "a" twice/)
  writeFileSync(
    boxes,
    JSON.stringify({
      width: W,
      height: H,
      boxes: [{ name: 'gone', x: 60, y: 0, width: 4, height: 4 }],
    }),
  )
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /"gone" covers no pixel/,
  )
  // Boxes may name their format: shaderera.boxes/1, which a file without one is too.
  const one = { width: W, height: H, boxes: [{ name: 'a', x: 0, y: 0, width: 4, height: 4 }] }
  writeFileSync(boxes, JSON.stringify({ format: 'shaderera.boxes/1', ...one }))
  assert.equal(
    (await compare({ reference: file, times: [1], regions: boxes })).regions?.kind,
    'boxes',
  )
  writeFileSync(boxes, JSON.stringify({ format: 'shaderera.boxes/2', ...one }))
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /is "shaderera\.boxes\/2": this shaderera reads shaderera\.boxes\/1\. Update shaderera\./,
  )
  writeFileSync(boxes, JSON.stringify({ format: 'something/1', ...one }))
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /reads shaderera\.analysis\/1 of kind regions and shaderera\.boxes\/1/,
  )
  writeFileSync(boxes, JSON.stringify([1, 2]))
  await assert.rejects(
    compare({ reference: file, times: [1], regions: boxes }),
    /is not a JSON object/,
  )
  await assert.rejects(
    compare({
      reference: file,
      times: [1],
      regions: boxes,
      region: { x: 0, y: 0, width: 20, height: 20 },
    }),
    /--regions scores parts of the whole frame: give it without --region/,
  )
  await assert.rejects(
    compare({ reference: file, times: [1], region: { x: 0, y: 0, width: 10, height: 20 } }),
    /SSIM needs at least 11×11 pixels, its window: the part measured is 10×20/,
  )
  // A region measures that part only.
  const part = await compare({
    reference: file,
    times: [1],
    region: { x: 20, y: 6, width: 24, height: 24 },
  })
  assert.deepEqual(part.region, { x: 20, y: 6, width: 24, height: 24 })
  assert.equal(part.frames[0]?.ssim, 1)
})

test('an image of another shape than the frame is refused unless --fit says how; the fit is recorded (#685)', async () => {
  const dir = tempDir('compare-image-fit')
  const file = join(dir, 'square.png')
  writeFileSync(
    file,
    encode({
      width: W,
      height: W,
      data: new Uint8Array(W * W * 4).fill(255),
      channels: 4,
      depth: 8,
    }),
  )
  await assert.rejects(
    compare({ reference: file, times: [0] }),
    /square\.png is 48×48 and the film is 48×36, another shape: give --fit stretch, contain or cover/,
  )
  await assert.rejects(
    compare({ reference: file, times: [0], fit: 'fill' }),
    /--fit is stretch, contain or cover, not "fill"/,
  )
  const r = await compare({ reference: file, times: [0], fit: 'stretch' })
  assert.deepEqual(r.scaled, {
    from: [W, W],
    to: [W, H],
    filter: 'triangle',
    aspect: 'stretched',
    fit: 'stretch',
  })
  assert.match(imageSummaryLines(r)[0] as string, /stretched by --fit stretch/)
})

/** Columns `x0` to `x1` of the film's frame at t, as an image `x1 - x0` wide: a still reference. */
const columns = (t: number, x0: number, x1: number, outside: number[] = [255, 255, 255, 255]) => {
  const px = frame(t)
  const w = x1 - x0
  const out = new Uint8Array(w * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < w; x++) {
      const at = x0 + x
      out.set(
        at >= 0 && at < W ? px.subarray((y * W + at) * 4, (y * W + at) * 4 + 4) : outside,
        (y * w + x) * 4,
      )
    }
  return { width: w, height: H, data: out }
}

const png = (
  dir: string,
  name: string,
  image: { width: number; height: number; data: Uint8Array },
) => {
  const file = join(dir, name)
  writeFileSync(file, encode({ ...image, channels: 4, depth: 8 }))
  return file
}

test('--fit contain and cover place the image at one scale and score only the pixels it covers (#704)', async () => {
  const dir = tempDir('compare-image-contain')
  // The film's own middle half, 24×36: contained, it covers x 12 to 36 at scale 1. Outside it the
  // film is its dark blue and the frame black: identical scores mean those pixels were not counted.
  const narrow = png(dir, 'narrow.png', columns(1, 12, 36))
  const contain = await compare({ reference: narrow, times: [1], fit: 'contain' })
  assert.deepEqual(contain.scaled, {
    from: [24, H],
    to: [W, H],
    filter: 'triangle',
    aspect: 'stretched',
    fit: 'contain',
    scale: 1,
    placed: { x: 12, y: 0, width: 24, height: H },
    masked: 12 * H * 2,
  })
  const [c] = contain.frames
  assert.equal(c?.psnr, Number.POSITIVE_INFINITY)
  assert.equal(c?.ssim, 1)
  assert.equal(c?.differing, 0)
  assert.match(
    imageSummaryLines(contain)[0] as string,
    /--fit contain at ×1: it covers 24×36 at 12,0, and the 864 pixels outside it are not scored/,
  )
  // Shown side by side: the part it covers only.
  const shown: number[] = []
  await compare({
    reference: narrow,
    times: [1],
    fit: 'contain',
    frame: async (f) => {
      shown.push(f.width, f.height)
    },
  })
  assert.deepEqual(shown, [24 * 3, H])

  // Scaled up: a 12×18 image of the background, twice as large, covers the same part.
  const small = png(dir, 'small.png', {
    width: 12,
    height: 18,
    data: Uint8Array.from({ length: 12 * 18 * 4 }, (_, i) => [20, 30, 60, 255][i % 4] as number),
  })
  const twice = await compare({ reference: small, times: [1.9], fit: 'contain' })
  assert.equal(twice.scaled?.scale, 2)
  assert.deepEqual(twice.scaled?.placed, { x: 12, y: 0, width: 24, height: H })
  // At 1.9 s the square has left that part: only background, as the image is.
  assert.equal(twice.frames[0]?.psnr, Number.POSITIVE_INFINITY)

  // Cover: a 96×36 image whose middle is the film's frame and whose sides (white) run off it.
  const wide = png(dir, 'wide.png', columns(1, -24, 72))
  const cover = await compare({ reference: wide, times: [1], fit: 'cover' })
  assert.deepEqual(cover.scaled, {
    from: [96, H],
    to: [W, H],
    filter: 'triangle',
    aspect: 'stretched',
    fit: 'cover',
    scale: 1,
    placed: { x: 0, y: 0, width: W, height: H },
    masked: 0,
  })
  assert.equal(cover.frames[0]?.psnr, Number.POSITIVE_INFINITY)
  assert.match(
    imageSummaryLines(cover)[0] as string,
    /--fit cover at ×1: it covers 48×36 at 0,0\)$/,
  )

  // Stretched instead, the same image is not the film.
  const stretched = await compare({ reference: narrow, times: [1], fit: 'stretch' })
  assert.ok((stretched.frames[0]?.ssim as number) < 1)

  // A region is cut to the part the image covers; one outside it is refused.
  const part = await compare({
    reference: narrow,
    times: [1],
    fit: 'contain',
    region: { x: 0, y: 0, width: 30, height: H },
  })
  assert.deepEqual(part.region, { x: 12, y: 0, width: 18, height: H })
  assert.equal(part.frames[0]?.ssim, 1)
  await assert.rejects(
    compare({
      reference: narrow,
      times: [1],
      fit: 'contain',
      region: { x: 0, y: 0, width: 12, height: H },
    }),
    /--region 0,0,12,36 is outside the image, which covers 24×36 at 12,0 of the frame \(--fit contain\)/,
  )

  // Regions in the image's pixels are placed as it is; boxes in the film's are cut to it.
  const boxes = join(dir, 'boxes.json')
  writeFileSync(
    boxes,
    JSON.stringify({
      width: 24,
      height: H,
      boxes: [{ name: 'left', x: 0, y: 0, width: 12, height: H }],
    }),
  )
  const regions = await compare({ reference: narrow, times: [1], fit: 'contain', regions: boxes })
  assert.deepEqual(regions.regions?.list[0]?.box, { x: 12, y: 0, width: 12, height: H })
  assert.equal(regions.frames[0]?.regions[0]?.ssim, 1)
  const filmBoxes = join(dir, 'film-boxes.json')
  writeFileSync(
    filmBoxes,
    JSON.stringify({
      width: W,
      height: H,
      boxes: [
        { name: 'across', x: 0, y: 0, width: 20, height: H },
        { name: 'bar', x: 0, y: 0, width: 10, height: H },
      ],
    }),
  )
  await assert.rejects(
    compare({ reference: narrow, times: [1], fit: 'contain', regions: filmBoxes }),
    /"bar" covers no pixel of the reference, at 24×36 12,0 in the 48×36 frame/,
  )
  writeFileSync(
    filmBoxes,
    JSON.stringify({
      width: W,
      height: H,
      boxes: [{ name: 'across', x: 0, y: 0, width: 20, height: H }],
    }),
  )
  const cut = await compare({ reference: narrow, times: [1], fit: 'contain', regions: filmBoxes })
  assert.deepEqual(cut.regions?.list[0]?.box, { x: 12, y: 0, width: 8, height: H })
  assert.equal(cut.regions?.list[0]?.area, 8 * H)
})

test('an image with alpha and a JPEG orientation say so in the report, applied as before (#690)', async () => {
  const dir = tempDir('compare-image-alpha')
  const px = frame(1)
  px[3] = 128
  const file = join(dir, 'half.png')
  writeFileSync(file, encode({ width: W, height: H, data: px, channels: 4, depth: 8 }))
  const r = await compare({ reference: file, times: [1] })
  assert.equal(r.reference.alpha, true)
  assert.equal(r.reference.orientation, undefined, 'a PNG has none')
  assert.equal(r.method.matte, 'black')
  assert.equal(
    imageSummaryLines(r)[0],
    `reference: ${W}×${H} image, matted over black (it has alpha)`,
  )
  assert.equal(
    imageSummaryLines({ ...r, reference: { ...r.reference, alpha: false, orientation: 6 } })[0],
    `reference: ${W}×${H} image, EXIF orientation 6 not applied`,
  )

  // A JPEG's APP1 Exif IFD0 with Orientation (0x0112), in either byte order.
  const jpeg = (le: boolean, orientation: number) => {
    const tiff = new DataView(new ArrayBuffer(26))
    tiff.setUint16(0, le ? 0x4949 : 0x4d4d)
    tiff.setUint16(2, 42, le)
    tiff.setUint32(4, 8, le)
    tiff.setUint16(8, 1, le)
    tiff.setUint16(10, 0x0112, le)
    tiff.setUint16(12, 3, le)
    tiff.setUint32(14, 1, le)
    tiff.setUint16(18, orientation, le)
    const exif = [...new TextEncoder().encode('Exif\0\0'), ...new Uint8Array(tiff.buffer)]
    const len = exif.length + 2
    return Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      4,
      0,
      0,
      0xff,
      0xe1,
      len >> 8,
      len & 255,
      ...exif,
      0xff,
      0xda,
    ])
  }
  assert.equal(exifOrientation(jpeg(true, 6)), 6)
  assert.equal(exifOrientation(jpeg(false, 8)), 8)
  assert.equal(exifOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xda])), undefined)
  assert.equal(exifOrientation(new Uint8Array([0x89, 0x50])), undefined)
})
