import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
})

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
  assert.match(alone.stderr, /--regions goes with --compare-file <image>/)
})
