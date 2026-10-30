import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { cli } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

test('still --compare: each t beside the other variant, with PSNR and mean ΔE, in text, --json and --sheet', async () => {
  const root = fileURLToPath(new URL('./fixtures/params/', import.meta.url))
  const out = tempDir('compare')
  const still = (...args: string[]) => cli('still', ...args, '--root', root, '--out', out)
  const text = await still('0', '0.5', '--compare', 'lighter', '--sheet')
  assert.equal(text.status, 0, text.stderr)
  assert.match(
    text.stdout,
    /main-vs-lighter-0\.500\.png {2}vs lighter: PSNR \d+\.\d\d dB, mean ΔE \d+\.\d{3}/,
  )
  const pair = decode(readFileSync(join(out, 'main-vs-lighter-0.500.png')))
  assert.equal(pair.width, 32)
  assert.deepEqual([...pair.data.subarray(0, 3)], [0, 0, 0])
  assert.deepEqual([...pair.data.subarray(16 * 4, 16 * 4 + 3)], [100, 100, 100])
  assert.ok(existsSync(join(out, 'main-vs-lighter-sheet.png')))

  const json = JSON.parse((await still('0.5', '--compare', 'lighter', '--json')).stdout).result
  const c = json.stills[0].compare
  assert.equal(c.variant, 'lighter')
  assert.ok(c.psnr > 0 && c.deltaE > 0)
  assert.equal(c.differing, 256)

  // The other way round, against the manifest's own output, named main as still names it.
  const back = JSON.parse(
    (await still('0.5', '--variant', 'lighter', '--compare', 'main', '--json')).stdout,
  )
  assert.equal(back.result.stills[0].compare.differing, 256)
  // An unknown variant is refused, and the host already open is closed (no hang).
  const typo = await still('0.5', '--compare', 'lightr')
  assert.equal(typo.status, 2)
  assert.match(typo.stderr, /no variant "lightr"/)

  // A param given goes to both: the same grey, so the same frames.
  const same = JSON.parse(
    (await still('0.5', '--compare', 'lighter', '--param', 'grey=7', '--json')).stdout,
  )
  assert.equal(same.result.stills[0].compare.psnr, null)
  assert.equal(same.result.stills[0].compare.deltaE, 0)
})

test('still --file reads stills and a sheet from a rendered file: --count, --from, --to and --columns (#537)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('still-file')
  cpSync(fileURLToPath(new URL('./fixtures/mcp/', import.meta.url)), root, { recursive: true })
  assert.equal((await cli('render', '--root', root)).status, 0)
  const film = join(root, 'out', `${basename(root)}.mp4`)
  const r = await cli(
    'still',
    '--file',
    film,
    '--count',
    '4',
    '--from',
    '0.2',
    '--to',
    '1',
    '--sheet',
    '--columns',
    '2',
    '--json',
  )
  assert.equal(r.status, 0, r.stderr)
  const { stills, sheet } = JSON.parse(r.stdout).result
  assert.deepEqual(
    stills.map((s: { t: number }) => s.t),
    [0.2, 0.4, 0.6, 0.8],
  )
  assert.equal(sheet, join(root, 'out', 'stills', `${basename(root)}-sheet.png`))
  // Two across, two down, each frame at its own 64×36.
  const png = decode(readFileSync(sheet))
  assert.deepEqual([png.width, png.height], [8 + 2 * (64 + 8), 8 + 2 * (36 + 22 + 8)])
  // The box the source draws at x 15 + t·10 (t 0.2: x 17) is in the file's frame.
  const still = decode(readFileSync(stills[0].file))
  assert.ok((still.data[(14 * 64 + 20) * 4] as number) > 128)
  const refused = await cli('still', '--file', film, '0', '--variant', 'short')
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /--variant renders the source/)
  assert.match(
    (await cli('still', '--file', film, '0', '--columns', '2')).stderr,
    /--columns lays out a --sheet/,
  )
})

test('a variant named what a file name cannot hold (16:9, a/b) still writes into out/stills', async () => {
  const root = tempDir('names')
  cpSync(fileURLToPath(new URL('./fixtures/mcp/', import.meta.url)), root, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  const variants = { '16:9': { duration: 0.5 }, 'a/b': { duration: 0.5 } }
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify({ ...manifest, variants }))
  for (const [variant, name] of [
    ['16:9', '16_9-0.000.png'],
    ['a/b', 'a_b-0.000.png'],
  ] as const) {
    const r = await cli('still', '0', '--variant', variant, '--root', root, '--json')
    assert.equal(r.status, 0, r.stderr)
    const file = JSON.parse(r.stdout).result.stills[0].file
    assert.equal(file, join(root, 'out', 'stills', name))
    assert.ok(existsSync(file))
  }
})
