import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const root = fileURLToPath(new URL('./fixtures/params/', import.meta.url))
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })

test('--param and positional times read alike on every command that renders', () => {
  const inspect = cli('inspect', '0.5', '--param', 'grey=200', '--json')
  assert.equal(inspect.status, 0, inspect.stderr)
  assert.deepEqual(JSON.parse(inspect.stdout).result, { t: 0.5, grey: 200 })
  assert.equal(cli('inspect', '--time', '0.5').stdout.trim(), 't 0.5\ngrey 0')

  const out = mkdtempSync(join(tmpdir(), 'shaderera-args-'))
  const still = cli('still', '0.5', '--param', 'grey=200', '--out', out)
  assert.equal(still.status, 0, still.stderr)
  const png = decode(readFileSync(join(out, 'main-0.500.png')))
  assert.deepEqual([...png.data.subarray(0, 4)], [200, 200, 200, 255])

  const check = cli('check', '--times', '2', '--param', 'grey=200')
  assert.equal(check.status, 0, check.stderr)
})

test('an unknown param is refused with the same message on every command', () => {
  for (const command of [['check'], ['inspect', '0'], ['still', '0'], ['render'], ['review']]) {
    const r = cli(...command, '--param', 'gray=1')
    assert.equal(r.status, 2, `${command[0]}: ${r.stderr}`)
    assert.match(
      r.stderr,
      /Unknown params: gray\. shaderera\.json declares grey\./,
      `${command[0]}: ${r.stderr}`,
    )
  }
})

test('a time outside the film, or one given where none is taken, is refused', () => {
  assert.match(cli('inspect', '1').stderr, /Outside the film \(0 to 1 s\): 1/)
  assert.match(cli('check', '0.5').stderr, /shaderera check takes no times \(0\.5\)/)
  assert.match(cli('inspect', 'soon').stderr, /Not a time in seconds: soon/)
})
