import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { encode } from 'fast-png'
import { tempDir } from '../fixtures/temp.ts'
import { compareWithFile } from './compare-file.ts'
import { type CompareImageReport, imageFrameLines, imageSummaryLines } from './compare-image.ts'

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
  assert.deepEqual(r.reference, { kind: 'image', file, width: W, height: H, bits: 8, sha256 })
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

test('--regions reads an image-regions artifact of the image, its u8 masks scaled to the frame (#665)', async () => {
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
    /reads shaderera\.analysis\/1 \(image-regions\) and shaderera\.boxes\/1/,
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
