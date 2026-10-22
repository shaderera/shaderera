import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
