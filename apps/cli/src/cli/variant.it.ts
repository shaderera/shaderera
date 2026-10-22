import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { tempDir } from '../fixtures/temp.ts'
import { labelSize } from '../review/variant-sheet.ts'

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const root = fileURLToPath(new URL('./fixtures/ratios/', import.meta.url))

const inspect = (host: string, ...variant: string[]) => {
  const r = spawnSync(
    process.execPath,
    [main, 'inspect', '0.5', '--root', root, '--host', host, '--json', ...variant],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).result
}

for (const host of ['node', 'browser']) {
  test(`${host} host: the source gets the variant's name as host.variant, and lays out by it`, () => {
    const own = inspect(host)
    assert.equal(own.variant, null)
    assert.equal(own.layout, 'side by side')
    const wide = inspect(host, '--variant', '16:9')
    assert.equal(wide.variant, '16:9')
    assert.equal(wide.layout, 'side by side')
    const tall = inspect(host, '--variant', '9:16')
    assert.equal(tall.variant, '9:16')
    assert.equal(tall.layout, 'stacked')
    // The size is the variant's too: the square is centred across 1080 px.
    assert.deepEqual(tall.block.bbox, [378, 1056, 324, 324])
  })
}

const cli = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })

test('still, check and review take several variants: one host each, grouped, the worst exit', () => {
  const out = tempDir('variants')
  const still = cli('still', '0.5', '--variant', '16:9,9:16', '--out', out, '--json')
  assert.equal(still.status, 0, still.stderr)
  const stills = JSON.parse(still.stdout).result.variants
  assert.deepEqual(
    stills.map((v: { variant: string; stills: { file: string }[] }) => [
      v.variant,
      basename(v.stills[0]?.file ?? ''),
    ]),
    [
      ['16:9', '16_9-0.500.png'],
      ['9:16', '9_16-0.500.png'],
    ],
  )
  const tall = decode(readFileSync(join(out, '9_16-0.500.png')))
  assert.deepEqual([tall.width, tall.height], [1080, 1920])

  const check = cli('check', '--variants', 'all', '--times', '2')
  assert.equal(check.status, 0, check.stderr)
  assert.match(
    check.stdout,
    /^main = 16:9\n16:9:\n {2}✓ deterministic.*\n.*\n9:16:\n {2}✓ deterministic/,
  )

  // The text runs inside a 5% safe area in both layouts; a 30% one fails each, named by variant.
  const strict = join(out, 'strict.json')
  writeFileSync(
    strict,
    JSON.stringify({ version: 1, safeArea: { top: 0.3, right: 0.3, bottom: 0.3, left: 0.3 } }),
  )
  const review = cli('review', '--variant', '16:9,9:16', '--quick', '--out', out, '--json')
  assert.equal(review.status, 0, review.stderr)
  const reviews = JSON.parse(review.stdout).result.variants
  assert.deepEqual(
    reviews.map((r: { variant: string; manifest: { width: number } }) => [
      r.variant,
      r.manifest.width,
    ]),
    [
      ['16:9', 1920],
      ['9:16', 1080],
    ],
  )
  assert.ok(existsSync(join(out, '16_9', 'contact-sheet.png')))
  assert.ok(existsSync(join(out, '9_16', 'contact-sheet.png')))
  const failing = cli(
    'review',
    '--variant',
    '16:9,9:16',
    '--quick',
    '--out',
    out,
    '--requirements',
    strict,
    '--json',
  )
  assert.equal(failing.status, 1, failing.stderr)
  const outputs = new Set(
    JSON.parse(failing.stdout)
      .findings.filter((f: { code: string }) => f.code === 'text-fit')
      .map((f: { output: string }) => f.output),
  )
  assert.deepEqual([...outputs].sort(), ['16:9', '9:16'])
})

test('still --sheet with several variants: one sheet, a row per moment, the variants side by side', () => {
  const out = tempDir('variant-sheet')
  const r = cli('still', '0.5', '1.5', '--variant', '16:9,9:16', '--sheet', '--out', out, '--json')
  assert.equal(r.status, 0, r.stderr)
  const { sheet, variants } = JSON.parse(r.stdout).result
  assert.equal(sheet, join(out, '16_9-9_16-sheet.png'))
  assert.equal(variants.length, 2)
  // No sheet of each variant's own: the one sheet holds them.
  assert.ok(!existsSync(join(out, '16_9-sheet.png')))
  const png = decode(readFileSync(sheet))
  // Each at 720 px high: 1280 + 405 wide with 8 px between, two rows with their labels: 24 px
  // type (3% of 720 is 22, but 24 stays 14 px when the sheet is shown 1024 px wide), padded to 44.
  assert.equal(labelSize(720, 1709), 24)
  assert.ok((24 * 1024) / 1709 >= 14)
  assert.equal(labelSize(200, 400), 14)
  assert.equal(labelSize(2000, 1000), 60)
  assert.deepEqual([png.width, png.height], [1709, 8 + 2 * (720 + 44 + 8)])
  // The safe area requirements.json declares is drawn on the sheet (dashed, #38d6ff)…
  let safe = 0
  const channels = png.channels
  for (let i = 0; i < png.data.length; i += channels)
    if (png.data[i] === 0x38 && png.data[i + 1] === 0xd6 && png.data[i + 2] === 0xff) safe++
  assert.ok(safe > 1000, `${safe} safe-area pixels`)
  // …and never on the stills: the same bytes as a still of that variant alone.
  const alone = tempDir('variant-alone')
  assert.equal(cli('still', '1.5', '--variant', '9:16', '--out', alone).status, 0)
  assert.deepEqual(
    readFileSync(join(out, '9_16-1.500.png')),
    readFileSync(join(alone, '9_16-1.500.png')),
  )
})
