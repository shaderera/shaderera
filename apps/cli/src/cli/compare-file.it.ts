import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { cli } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/** The fixture film rendered with `args` (a param, a variant) to its own file: a reference. */
const reference = async (root: string, name: string, ...args: string[]) => {
  const r = await cli('render', '--root', root, ...args)
  assert.equal(r.status, 0, r.stderr)
  const variant = args.includes('--variant') ? `-${args[args.indexOf('--variant') + 1]}` : ''
  const file = join(root, `${name}.mp4`)
  renameSync(join(root, 'out', `${basename(root)}${variant}.mp4`), file)
  return file
}

test('still --compare-file finds a reference rendered 3 frames late, and measures it aligned with --offset (#664)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('compare-file')
  cpSync(fileURLToPath(new URL('./fixtures/reference/', import.meta.url)), root, {
    recursive: true,
  })
  const late = await reference(root, 'late', '--param', 'delay=0.3')
  const out = join(root, 'stills')
  const still = (...args: string[]) =>
    cli('still', '--root', root, '--out', out, '--compare-file', late, ...args)

  const r = await still('--json', '--sheet', '--max-shift', '5')
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout).result
  // The reference's frames at its own rate over the whole film.
  assert.equal(report.frames.length, 20)
  assert.equal(report.step, 0.1)
  assert.equal(report.scaled, null)
  assert.equal(report.offset.applied, 0)
  assert.equal(report.offset.found.steps, 3)
  assert.equal(report.offset.found.seconds, 0.3)
  assert.ok(report.offset.found.correlation > 0.9)
  assert.equal(report.offset.scores.length, 11)
  // The film moves from 0.6 s (the first frame after 0.5 s) to 1.2 s; the reference 0.3 s later.
  assert.equal(report.window.film.first, 0.6)
  assert.equal(report.window.film.last, 1.2)
  // Codec noise is not counted as still at floor 0: the reference's window is at least the move.
  assert.ok(report.window.reference.first <= 0.9 && report.window.reference.last >= 1.5)
  // Each time: the film, the reference and the difference side by side.
  const png = decode(readFileSync(report.frames[8].file))
  assert.deepEqual([png.width, png.height], [64 * 3, 36])
  assert.ok(existsSync(report.sheet))

  // Read 0.3 s later, the reference lines up: its motion window is the film's.
  const aligned = JSON.parse(
    (await still('--offset', '0.3', '--floor', '2', '--json')).stdout,
  ).result
  assert.equal(aligned.offset.applied, 0.3)
  assert.equal(aligned.offset.found.steps, 0)
  assert.equal(aligned.frames.length, 17)
  assert.equal(aligned.window.reference.first, 0.6)
  assert.equal(aligned.window.reference.last, 1.2)
  assert.ok(aligned.frames[7].psnr > 30, `PSNR ${aligned.frames[7].psnr}`)

  // The human output says what was found and the offset that aligns them.
  const text = await still('0.5', '0.6', '0.7', '0.8', '0.9', '1', '1.1', '1.2', '--max-shift', '3')
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /main-vs-late-0\.800\.png {2}\d+ ms {2}PSNR/)
  assert.match(text.stdout, /align best at \+3 steps of 0\.1 s .*Aligned: --offset=0\.3$/m)

  // A reference at another size is scaled to the film's frame, and the report says so.
  const large = await reference(root, 'large', '--variant', 'large', '--param', 'delay=0.3')
  const big = JSON.parse(
    (await cli('still', '--root', root, '--out', out, '--compare-file', large, '--json')).stdout,
  ).result
  assert.deepEqual(big.scaled, {
    from: [128, 72],
    to: [64, 36],
    filter: 'triangle',
    aspect: 'same',
  })
  assert.equal(big.offset.found.steps, 3)

  // A region measures that part only.
  const part = JSON.parse((await still('--region', '0,0,32,36', '--json')).stdout).result
  assert.deepEqual(part.region, { x: 0, y: 0, width: 32, height: 36 })
  assert.deepEqual(decode(readFileSync(part.frames[0].file)).width, 32 * 3)

  // Bad input exits 2 with what is wrong.
  const outside = await still('--offset', '5')
  assert.equal(outside.status, 2)
  assert.match(outside.stderr, /Nothing to compare/)
  const uneven = await still('0', '0.1', '0.5', '--max-shift', '2')
  assert.equal(uneven.status, 2)
  assert.match(uneven.stderr, /not evenly spaced|are not/)
  const both = await still('--compare', 'large')
  assert.equal(both.status, 2)
  assert.match(both.stderr, /--compare is not for --compare-file/)
  const alone = await cli('still', '0', '--root', root, '--offset', '1')
  assert.equal(alone.status, 2)
  assert.match(alone.stderr, /--offset goes with --compare-file/)

  // A still image is not read as a clip of one time: it needs the times to compare it at (#665).
  const still1 = join(root, 'frame.png')
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', late, '-frames:v', '1', still1]).status, 0)
  const image = await cli('still', '--root', root, '--out', out, '--compare-file', still1)
  assert.equal(image.status, 2)
  assert.match(image.stderr, /is a still image: give the film's times/)
  // A clip of one frame that is not a PNG or JPEG is refused as one.
  const one = join(root, 'one.mp4')
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', late, '-frames:v', '1', one]).status, 0)
  const single = await cli('still', '0', '--root', root, '--out', out, '--compare-file', one)
  assert.equal(single.status, 2)
  assert.match(single.stderr, /a clip of one frame: .* save it as a PNG once/)

  // A clip whose frames are not at i / fps (a screen recording's held frame) is read at each
  // frame's own time, and each frame held until the next (#703).
  const vfr = join(root, 'vfr.mp4')
  const made = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    late,
    '-vf',
    "setpts='if(gte(N,5),PTS+0.3/TB,PTS)'",
    '-fps_mode',
    'vfr',
    vfr,
  ])
  assert.equal(made.status, 0, String(made.stderr))
  const own = await cli('still', '--root', root, '--out', out, '--compare-file', vfr, '--json')
  assert.equal(own.status, 0, own.stderr)
  const varying = JSON.parse(own.stdout).result
  assert.equal(varying.reference.timing, 'variable')
  assert.deepEqual(varying.reference.intervals, { smallest: 0.1, largest: 0.4 })
  assert.equal(varying.reference.duration, 2.3)
  // With no times, the clip's own frames up to the film's end: 0 to 0.4, then 0.8 to 1.9.
  const at = [0, 0.1, 0.2, 0.3, 0.4, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9]
  assert.deepEqual(
    varying.frames.map((f: { t: number }) => f.t),
    at,
  )
  assert.deepEqual(
    varying.frames.map((f: { read: number }) => f.read),
    at,
  )
  assert.deepEqual(
    varying.frames.map((f: { frame: number }) => f.frame),
    at.map((_, i) => i),
  )
  assert.equal(varying.step, null)
  // Times between frames read the last frame before them, held: frame 4 from 0.4 s to 0.8 s.
  const held = await cli(
    'still',
    '--root',
    root,
    '--out',
    out,
    '--compare-file',
    vfr,
    '--to',
    '1',
    '--count',
    '10',
    '--json',
  )
  assert.equal(held.status, 0, held.stderr)
  const sampled = JSON.parse(held.stdout).result.frames
  assert.deepEqual(
    sampled.map((f: { frame: number }) => f.frame),
    [0, 1, 2, 3, 4, 4, 4, 4, 5, 6],
  )
  assert.deepEqual(
    sampled.map((f: { read: number }) => f.read),
    [0, 0.1, 0.2, 0.3, 0.4, 0.4, 0.4, 0.4, 0.8, 0.9],
  )
  // A frame held is the same frame: no change on the reference's side.
  assert.equal(sampled[6].activity.reference, 0)
  assert.equal(sampled[7].activity.reference, 0)
  const lines = await cli('still', '--root', root, '--out', out, '--compare-file', vfr)
  assert.equal(lines.status, 0, lines.stderr)
  assert.match(
    lines.stdout,
    /^reference: 64×36 at a variable rate \(frames 0\.1–0\.4 s apart\), 2\.3 s$/m,
  )
})

test('still --compare-file reports each frame read, the reference as decoded, and a sheet of at most 64 (#674)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('compare-file-sheet')
  cpSync(fileURLToPath(new URL('./fixtures/reference/', import.meta.url)), root, {
    recursive: true,
  })
  const same = await reference(root, 'same')
  const r = await cli(
    'still',
    '--root',
    root,
    '--out',
    join(root, 'stills'),
    '--compare-file',
    same,
    '--count',
    '70',
    '--sheet',
    '--json',
  )
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout).result
  assert.equal(report.reference.timing, 'constant')
  assert.equal(report.reference.bits, 8)
  assert.ok(report.reference.colour.matrix)
  // 70 times over 2 s at 10 fps: the time asked for, and the frame read for it.
  assert.equal(report.frames.length, 70)
  assert.equal(report.frames[36].at, round(36 * (2 / 70)))
  assert.equal(report.frames[36].frame, 10)
  // Every time has its PNG; the sheet holds 64 rows of 36 px, each with its label and padding.
  assert.equal(new Set(report.frames.map((f: { file: string }) => f.file)).size, 70)
  assert.equal(decode(readFileSync(report.sheet)).height, 8 + 64 * (36 + 22 + 8))
})

const round = (t: number) => Number(t.toFixed(6))

test('still --compare-file finds a reference that moves earlier, and the offset it prints runs as given (#664)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('compare-file-early')
  cpSync(fileURLToPath(new URL('./fixtures/reference/', import.meta.url)), root, {
    recursive: true,
  })
  const early = await reference(root, 'early', '--param', 'delay=-0.2')
  const still = (...args: string[]) =>
    cli('still', '--root', root, '--out', join(root, 'stills'), '--compare-file', early, ...args)
  const r = await still()
  assert.equal(r.status, 0, r.stderr)
  const hint = /Aligned: (--offset=-0\.2)$/m.exec(r.stdout)
  assert.ok(hint, r.stdout)
  const aligned = await still(hint[1] as string, '--json')
  assert.equal(aligned.status, 0, aligned.stderr)
  assert.equal(JSON.parse(aligned.stdout).result.offset.found.steps, 0)
})

test('still --compare-file at 30 fps reads every frame of the reference at its own time (#664)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  // At 30 fps, 1/30 s written to 6 decimals (0.033333) falls just before frame 1.
  const root = tempDir('compare-file-30')
  cpSync(fileURLToPath(new URL('./fixtures/reference/', import.meta.url)), root, {
    recursive: true,
  })
  const manifest = join(root, 'shaderera.json')
  writeFileSync(
    manifest,
    JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), fps: 30 }, null, 2),
  )
  const same = await reference(root, 'same')
  const r = await cli(
    'still',
    '--root',
    root,
    '--out',
    join(root, 'stills'),
    '--compare-file',
    same,
    '--json',
  )
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout).result
  assert.equal(report.frames.length, 60)
  assert.equal(report.step, 0.033333)
  assert.equal(report.offset.found.steps, 0)
  assert.equal(report.frames[1].t, 0.033333)
  for (const f of report.frames) {
    // The same frame on both sides: only codec noise between them.
    assert.ok(f.psnr === null || f.psnr > 28, `PSNR ${f.psnr} at ${f.t}`)
    // While the film moves, so does the reference, by about as much: no frame read twice.
    const { film, reference } = f.activity
    if (film !== null && film > 0.3)
      assert.ok(
        reference > 0.3 && Math.abs(film - reference) < 2.5,
        `activity ${film} vs ${reference} at ${f.t}`,
      )
  }
})

test('still --compare-file <image> scores the film against a still, whole and per region (#665)', async () => {
  const root = tempDir('compare-image')
  cpSync(fileURLToPath(new URL('./fixtures/reference/', import.meta.url)), root, {
    recursive: true,
  })
  // The film's own still at 1.2 s, the move's end, as a poster to copy.
  const made = await cli('still', '1.2', '--root', root, '--out', join(root, 'ref'))
  assert.equal(made.status, 0, made.stderr)
  const poster = join(root, 'ref', 'main-1.200.png')
  // Boxes in the poster's pixels: where the box ends (x 44.8–56.8), and a strip above the path, out of reach of its windows.
  const boxes = join(root, 'boxes.json')
  writeFileSync(
    boxes,
    JSON.stringify({
      width: 64,
      height: 36,
      boxes: [
        { name: 'box', x: 44, y: 12, width: 14, height: 12 },
        { name: 'top', x: 26, y: 0, width: 10, height: 6 },
      ],
    }),
  )
  const out = join(root, 'stills')
  const still = (...args: string[]) =>
    cli('still', '--root', root, '--out', out, '--compare-file', poster, ...args)

  const r = await still('0', '1.2', '--regions', boxes, '--sheet', '--json')
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout).result
  assert.equal(report.reference.kind, 'image')
  assert.deepEqual([report.reference.width, report.reference.height], [64, 36])
  assert.equal(report.method.ssim.size, 11)
  assert.deepEqual(
    report.regions.list.map((q: { id: string }) => q.id),
    ['box', 'top'],
  )
  const [at0, at12] = report.frames
  // At 1.2 s the film is its own still: identical (PSNR null in JSON), SSIM and edges 1.
  assert.equal(at12.psnr, null)
  assert.equal(at12.ssim, 1)
  assert.equal(at12.edges.agreement, 1)
  // At 0 the box is still at the left: its end place differs, the strip does not.
  assert.ok(at0.ssim < 1)
  const box = at0.regions.find((q: { id: string }) => q.id === 'box')
  const top = at0.regions.find((q: { id: string }) => q.id === 'top')
  assert.ok(box.ssim < 0.5, `box SSIM ${box.ssim}`)
  assert.ok(box.deltaE > 20, `box ΔE ${box.deltaE}`)
  assert.equal(top.ssim, 1)
  assert.equal(top.deltaE, 0)
  // Each time's film, poster and SSIM heat map side by side, and the sheet.
  const png = decode(readFileSync(at0.file))
  assert.deepEqual([png.width, png.height], [64 * 3, 36])
  assert.ok(existsSync(report.sheet))

  // The human output: the whole frame's line, then each region's.
  const text = await still('0', '--regions', boxes)
  assert.equal(text.status, 0, text.stderr)
  assert.match(
    text.stdout,
    /main-vs-main-1\.200-0\.000\.png {2}\d+ ms {2}PSNR .*; SSIM 0\.\d{3}, edges 0\.\d{3}$/m,
  )
  assert.match(text.stdout, /^ {2}top: SSIM 1\.000, no edges, mean ΔE 0\.000 \(max 0\.00\)$/m)
  assert.match(text.stdout, /^reference: 64×36 image$/m)
  assert.match(text.stdout, /^regions: box, top \(boxes in 64×36\)$/m)

  // Bad input exits 2 with what is wrong.
  const none = await still()
  assert.equal(none.status, 2)
  assert.match(none.stderr, /is a still image: give the film's times/)
  const offset = await still('0', '--offset', '0.1')
  assert.equal(offset.status, 2)
  assert.match(offset.stderr, /--offset reads a clip over time/)
  const alone = await cli('still', '0', '--root', root, '--regions', boxes)
  assert.equal(alone.status, 2)
  assert.match(alone.stderr, /--regions goes with --compare-file <video\|image>/)
})

test('still --compare-file <clip> scores SSIM and edges per frame, whole and per region, with a fit (#677)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('compare-clip-ssim')
  cpSync(fileURLToPath(new URL('./fixtures/reference/', import.meta.url)), root, {
    recursive: true,
  })
  const same = await reference(root, 'same')
  // The known change: from 1 s on, a white block in the top-left corner, where the film has none.
  const changed = join(root, 'changed.mp4')
  const made = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    same,
    '-vf',
    "drawbox=x=0:y=0:w=16:h=8:color=white:t=fill:enable='gte(t,1)'",
    changed,
  ])
  assert.equal(made.status, 0, String(made.stderr))
  // Boxes in the clip's pixels: the corner that changes, and the bottom strip that never does.
  const boxes = join(root, 'boxes.json')
  writeFileSync(
    boxes,
    JSON.stringify({
      width: 64,
      height: 36,
      boxes: [
        { name: 'corner', x: 0, y: 0, width: 16, height: 8 },
        { name: 'bottom', x: 0, y: 30, width: 64, height: 6 },
      ],
    }),
  )
  const out = join(root, 'stills')
  const still = (...args: string[]) =>
    cli('still', '--root', root, '--out', out, '--compare-file', changed, ...args)

  const r = await still('--regions', boxes, '--json')
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout).result
  assert.equal(report.method.ssim.size, 11)
  assert.equal(report.regions.kind, 'boxes')
  assert.equal(report.frames.length, 20)
  type Frame = {
    t: number
    ssim: number
    edges: { agreement: number | null; film: number; reference: number }
    regions: { id: string; ssim: number; edges: { film: number; reference: number } }[]
  }
  const region = (f: Frame, id: string) => f.regions.find((q) => q.id === id) as Frame['regions'][0]
  for (const f of report.frames as Frame[]) {
    const corner = region(f, 'corner')
    // The strip never changes: only codec noise between the two.
    assert.ok(region(f, 'bottom').ssim > 0.9, `bottom SSIM ${region(f, 'bottom').ssim} at ${f.t}`)
    if (f.t < 1) {
      assert.ok(corner.ssim > 0.9, `corner SSIM ${corner.ssim} at ${f.t}`)
      assert.ok(f.ssim > 0.9, `SSIM ${f.ssim} at ${f.t}`)
    } else {
      // The block: other structure in the corner, and edges the film does not have.
      assert.ok(corner.ssim < 0.5, `corner SSIM ${corner.ssim} at ${f.t}`)
      assert.ok(corner.edges.reference > corner.edges.film + 10, `corner edges at ${f.t}`)
      assert.ok(f.ssim < (report.frames[0] as Frame).ssim, `SSIM ${f.ssim} at ${f.t}`)
      assert.ok((f.edges.agreement as number) < 1)
    }
  }
  // The timing measurements are as they were: the change is not motion of the film's.
  assert.equal(report.offset.found.steps, 0)

  // A regions artifact of the clip (its sha256) scores its mask as the box does.
  const artifact = join(root, 'regions')
  mkdirSync(artifact)
  writeFileSync(join(artifact, 'corner.u8'), new Uint8Array(16 * 8).fill(255))
  const sha256 = createHash('sha256').update(readFileSync(changed)).digest('hex')
  writeFileSync(
    join(artifact, 'regions.json'),
    JSON.stringify({
      format: 'shaderera.analysis/1',
      kind: 'regions',
      source: { path: 'changed.mp4', sha256, width: 64, height: 36 },
      regions: [
        {
          id: 'corner',
          mask: {
            file: 'corner.u8',
            dtype: 'u8',
            channels: 1,
            width: 16,
            height: 8,
            rowStride: 16,
            at: [0, 0],
          },
        },
      ],
    }),
  )
  const a = JSON.parse((await still('1.5', '--regions', artifact, '--json')).stdout).result
  const fromBoxes = (report.frames as Frame[]).find((f) => f.t === 1.5) as Frame
  assert.equal(a.regions.kind, 'regions')
  assert.equal(a.frames[0].regions[0].ssim, region(fromBoxes, 'corner').ssim)
  // One of other bytes is refused.
  const other = await cli(
    'still',
    '1.5',
    '--root',
    root,
    '--out',
    out,
    '--compare-file',
    same,
    '--regions',
    artifact,
  )
  assert.equal(other.status, 2)
  assert.match(other.stderr, /measured from other bytes/)

  // The human output: SSIM and edges on each time's line, then each region's.
  const text = await still('1.5', '--regions', boxes)
  assert.equal(text.status, 0, text.stderr)
  assert.match(
    text.stdout,
    /main-vs-changed-1\.500\.png {2}\d+ ms {2}PSNR .*; SSIM 0\.\d{3}, edges 0\.\d{3}; change/,
  )
  assert.match(text.stdout, /^ {2}corner: SSIM -?0\.\d{3}, edges 0\.\d{3}, mean ΔE/m)
  assert.match(text.stdout, /^regions: corner, bottom \(boxes in 64×36\)$/m)

  // --heat-map shows the SSIM heat map in place of the difference; the numbers are the same.
  const plain = JSON.parse((await still('1.5', '--json')).stdout).result.frames[0]
  const diffPng = decode(readFileSync(plain.file)).data
  const heat = JSON.parse((await still('1.5', '--heat-map', '--json')).stdout).result.frames[0]
  const heatPng = decode(readFileSync(heat.file)).data
  assert.equal(heat.ssim, plain.ssim)
  const panel = (px: ArrayLike<number>, k: number) =>
    Array.from({ length: 36 }, (_, y) =>
      Array.from(px).slice((y * 192 + k * 64) * 4, (y * 192 + (k + 1) * 64) * 4),
    ).flat()
  assert.deepEqual(panel(heatPng, 0), panel(diffPng, 0))
  assert.notDeepEqual(panel(heatPng, 2), panel(diffPng, 2))

  // A clip of another shape is refused without a fit (decision 0032); with stretch it is scaled
  // to the frame, and with contain placed, the film's pixels outside it not scored.
  const tall = join(root, 'tall.mp4')
  const padded = spawnSync('ffmpeg', ['-v', 'error', '-i', same, '-vf', 'pad=64:48:0:6', tall])
  assert.equal(padded.status, 0, String(padded.stderr))
  const tallStill = (...args: string[]) =>
    cli('still', '--root', root, '--out', out, '--compare-file', tall, '1', ...args)
  const refused = await tallStill()
  assert.equal(refused.status, 2)
  assert.match(
    refused.stderr,
    /tall\.mp4 is 64×48 and the film is 64×36, another shape: give --fit stretch, contain or cover/,
  )
  const stretchedRun = await tallStill('--fit', 'stretch', '--json')
  assert.equal(stretchedRun.status, 0, stretchedRun.stderr)
  const stretched = JSON.parse(stretchedRun.stdout).result
  assert.equal(stretched.scaled.aspect, 'stretched')
  assert.equal(stretched.scaled.fit, 'stretch')
  assert.equal(decode(readFileSync(stretched.frames[0].file)).width, 64 * 3)
  const contained = await tallStill('--fit', 'contain', '--regions', boxes, '--json')
  assert.equal(contained.status, 0, contained.stderr)
  const c = JSON.parse(contained.stdout).result
  assert.equal(c.scaled.fit, 'contain')
  assert.deepEqual(c.scaled.placed, { x: 8, y: 0, width: 48, height: 36 })
  assert.equal(c.scaled.masked, 64 * 36 - 48 * 36)
  assert.equal(decode(readFileSync(c.frames[0].file)).width, 48 * 3)
  // Boxes in the film's pixels are cut to the part the clip covers.
  assert.equal(c.regions.list.find((q: { id: string }) => q.id === 'corner').box.x, 8)
})
