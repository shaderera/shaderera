import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'

test('still --compare: each t beside the other variant, with PSNR and mean ΔE, in text, --json and --sheet', () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = fileURLToPath(new URL('./fixtures/params/', import.meta.url))
  const out = mkdtempSync(join(tmpdir(), 'shaderera-compare-'))
  const still = (...args: string[]) =>
    spawnSync(process.execPath, [main, 'still', ...args, '--root', root, '--out', out], {
      encoding: 'utf8',
    })
  const text = still('0', '0.5', '--compare', 'lighter', '--sheet')
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

  const json = JSON.parse(still('0.5', '--compare', 'lighter', '--json').stdout).result
  const c = json.stills[0].compare
  assert.equal(c.variant, 'lighter')
  assert.ok(c.psnr > 0 && c.deltaE > 0)
  assert.equal(c.differing, 256)

  // The other way round, against the manifest's own output, named main as still names it.
  const back = JSON.parse(
    still('0.5', '--variant', 'lighter', '--compare', 'main', '--json').stdout,
  )
  assert.equal(back.result.stills[0].compare.differing, 256)
  // An unknown variant is refused, and the host already open is closed (no hang).
  const typo = still('0.5', '--compare', 'lightr')
  assert.equal(typo.status, 2)
  assert.match(typo.stderr, /no variant "lightr"/)

  // A param given goes to both: the same grey, so the same frames.
  const same = JSON.parse(
    still('0.5', '--compare', 'lighter', '--param', 'grey=7', '--json').stdout,
  )
  assert.equal(same.result.stills[0].compare.psnr, null)
  assert.equal(same.result.stills[0].compare.deltaE, 0)
})

test('a variant named what a file name cannot hold (16:9, a/b) still writes into out/stills', () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'shaderera-names-'))
  cpSync(fileURLToPath(new URL('./fixtures/mcp/', import.meta.url)), root, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  const variants = { '16:9': { duration: 0.5 }, 'a/b': { duration: 0.5 } }
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify({ ...manifest, variants }))
  for (const [variant, name] of [
    ['16:9', '16_9-0.000.png'],
    ['a/b', 'a_b-0.000.png'],
  ] as const) {
    const r = spawnSync(
      process.execPath,
      [main, 'still', '0', '--variant', variant, '--root', root, '--json'],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr)
    const file = JSON.parse(r.stdout).result.stills[0].file
    assert.equal(file, join(root, 'out', 'stills', name))
    assert.ok(existsSync(file))
  }
})
