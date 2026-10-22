import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { cli as run } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'

const root = fileURLToPath(new URL('./fixtures/params/', import.meta.url))
const cli = (...args: string[]) => run(...args, '--root', root)

test('--param and positional times read alike on every command that renders', async () => {
  const inspect = await cli('inspect', '0.5', '--param', 'grey=200', '--json')
  assert.equal(inspect.status, 0, inspect.stderr)
  assert.deepEqual(JSON.parse(inspect.stdout).result, { t: 0.5, grey: 200 })
  assert.equal((await cli('inspect', '--time', '0.5')).stdout.trim(), 't 0.5\ngrey 0')

  const out = tempDir('args')
  const still = await cli('still', '0.5', '--param', 'grey=200', '--out', out)
  assert.equal(still.status, 0, still.stderr)
  const png = decode(readFileSync(join(out, 'main-0.500.png')))
  assert.deepEqual([...png.data.subarray(0, 4)], [200, 200, 200, 255])

  const check = await cli('check', '--times', '2', '--param', 'grey=200')
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /✓ deterministic: 2 timestamps/)
})

test('an unknown param is refused with the same message on every command', async () => {
  for (const command of [['check'], ['inspect', '0'], ['still', '0'], ['render'], ['review']]) {
    const r = await cli(...command, '--param', 'gray=1')
    assert.equal(r.status, 2, `${command[0]}: ${r.stderr}`)
    assert.match(
      r.stderr,
      /Unknown params: gray\. shaderera\.json declares grey\./,
      `${command[0]}: ${r.stderr}`,
    )
  }
  // The render, refused before the source opens, saved no revision.
  assert.equal(existsSync(join(root, 'versions')), false)
})

test('a time outside the film, or one given where none is taken, is refused', async () => {
  assert.match((await cli('inspect', '1')).stderr, /Outside the film \(0 to 1 s\): 1/)
  assert.match((await cli('check', '0.5')).stderr, /shaderera check takes no times \(0\.5\)/)
  assert.match((await cli('inspect', 'soon')).stderr, /Not a time in seconds: soon/)
})
