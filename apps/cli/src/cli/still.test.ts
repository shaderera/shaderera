import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { parseParam, timesOf } from './args.ts'
import { stillTimes } from './still.ts'

test('stillTimes takes the given times and adds one every `every` seconds', () => {
  assert.deepEqual(stillTimes([1.5, 4], undefined, 10), [1.5, 4])
  assert.deepEqual(stillTimes([], 2.5, 10), [0, 2.5, 5, 7.5])
  assert.deepEqual(stillTimes([9], 5, 10), [9, 0, 5])
})

test('stillTimes refuses no time, a non-number and a time outside the film', () => {
  assert.throws(() => stillTimes([], undefined, 10), /Usage: shaderera still/)
  assert.throws(() => timesOf(['soon']), /Not a time in seconds: soon/)
  assert.throws(() => stillTimes([10], undefined, 10), /Outside the film \(0 to 10 s\): 10/)
  assert.throws(() => stillTimes([], 0, 10), /--every needs seconds above 0/)
})

test('parseParam reads JSON values and keeps anything else as a string', () => {
  assert.deepEqual(parseParam('count=4096'), ['count', 4096])
  assert.deepEqual(parseParam('look=ascii'), ['look', 'ascii'])
  assert.deepEqual(parseParam('tint=[1,0.5,0]'), ['tint', [1, 0.5, 0]])
  assert.throws(() => parseParam('=1'), /key=value/)
})

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

  // A param given goes to both: the same grey, so the same frames.
  const same = JSON.parse(
    still('0.5', '--compare', 'lighter', '--param', 'grey=7', '--json').stdout,
  )
  assert.equal(same.result.stills[0].compare.psnr, null)
  assert.equal(same.result.stills[0].compare.deltaE, 0)
})
