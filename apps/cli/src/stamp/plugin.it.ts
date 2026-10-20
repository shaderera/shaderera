import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('the package exports the stamp as shaderera/stamp, with its types', async () => {
  const name = 'shaderera/stamp' // a variable: typecheck does not need dist built
  const url = import.meta.resolve(name)
  assert.equal(url, new URL('../../dist/stamp/plugin.js', import.meta.url).href)
  // The public name loads the built plugin: `test:slow` and `test:all` build first.
  const module = (await import(name)) as typeof import('./plugin.ts')
  assert.deepEqual(Object.keys(module).sort(), ['stamp', 'stampCode']) // docs/api.md
  const { stamp } = module
  assert.equal(stamp({ root: '.' }).name, 'shaderera:stamp')
  const types = new URL('../../dist/stamp/plugin.d.ts', import.meta.url)
  assert.match(readFileSync(types, 'utf8'), /export declare const stamp/)
})
