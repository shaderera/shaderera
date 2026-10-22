import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// docs/api.md: the package exports no JavaScript. Its modules are internal; adding an export is a
// visible change, made here on purpose.
test('the shaderera package exports nothing but its package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.exports, { './package.json': './package.json' })
  assert.ok(import.meta.resolve('shaderera/package.json').endsWith('/apps/cli/package.json'))
  for (const name of ['shaderera', 'shaderera/stamp', 'shaderera/dist/runner/worker.js'])
    assert.throws(() => import.meta.resolve(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, name)
})
