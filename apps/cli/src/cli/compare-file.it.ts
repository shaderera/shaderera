import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, renameSync } from 'node:fs'
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
  assert.match(text.stdout, /align best at \+3 steps of 0\.1 s .*Aligned: --offset 0\.3/)

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
})
