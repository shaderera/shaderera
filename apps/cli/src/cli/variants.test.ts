import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Manifest } from '@shaderera/core'
import { EXIT, findings } from './findings.ts'
import { eachVariant, variantNames } from './variants.ts'

const manifest = {
  entry: './src/composition.ts',
  fps: 10,
  duration: 2,
  width: 1920,
  height: 1080,
  variants: { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 } },
} satisfies Manifest

test('variantNames: one, a list, all, main as undefined, and an unknown name refused', () => {
  assert.deepEqual(variantNames({}, manifest), [undefined])
  assert.deepEqual(variantNames({ variant: '9:16' }, manifest), ['9:16'])
  assert.deepEqual(variantNames({ variant: '16:9, 9:16' }, manifest), ['16:9', '9:16'])
  assert.deepEqual(variantNames({ variants: '9:16,main,9:16' }, manifest), ['9:16', undefined])
  assert.deepEqual(variantNames({ variants: 'all' }, manifest), [undefined, '16:9', '9:16'])
  // A declared name is taken whole, comma and all.
  const odd = { ...manifest, variants: { 'a,b': { duration: 1 } } }
  assert.deepEqual(variantNames({ variant: 'a,b' }, odd), ['a,b'])
  assert.throws(
    () => variantNames({ variant: '16:9,4:5' }, manifest),
    /no variant "4:5" \(it declares 16:9, 9:16, and main\)/,
  )
  assert.throws(() => variantNames({ variant: 'a', variants: 'b' }, manifest), /not both/)
  assert.throws(() => variantNames({ variants: ',' }, manifest), /No variant/)
})

const root = fileURLToPath(new URL('./fixtures/ratios/', import.meta.url))

test('eachVariant: one variant runs as given; several run at once, grouped, tagged and the worst exit', async (t) => {
  const lines: string[] = []
  const errors: string[] = []
  t.mock.method(console, 'log', (line: string) => lines.push(line))
  t.mock.method(console, 'error', (line: string) => errors.push(line))
  findings.length = 0

  const one = await eachVariant({ root, variant: '9:16' }, async (flags, out) => {
    assert.equal(flags.variant, '9:16')
    assert.equal(out.several, false)
    out.log('a line')
    return EXIT.ok
  })
  assert.equal(one, EXIT.ok)
  assert.deepEqual(lines, ['a line'])

  lines.length = 0
  const order: string[] = []
  const several = await eachVariant(
    { root, variants: 'all' } as { root: string; variant?: string; variants?: string },
    async (flags, out) => {
      const name = String(flags.variant ?? 'main')
      assert.equal('variants' in flags, false)
      // The first given finishes last: printed in the order given all the same.
      await new Promise((done) => setTimeout(done, name === 'main' ? 30 : 0))
      order.push(name)
      out.log(`rendered ${name}\nsecond line`)
      if (name === '16:9') out.found({ code: 'end-hold', severity: 'error', message: 'short' })
      if (name === '9:16') throw new Error('it broke')
      return name === '16:9' ? EXIT.failed : EXIT.ok
    },
  )
  assert.deepEqual(order, ['16:9', '9:16', 'main'])
  assert.equal(several, EXIT.error)
  assert.deepEqual(lines, [
    'main:',
    '  rendered main\n  second line',
    '16:9:',
    '  rendered 16:9\n  second line',
    '9:16:',
    '  rendered 9:16\n  second line',
  ])
  assert.deepEqual(errors, ['shaderera: 9:16: it broke'])
  assert.deepEqual(
    findings.map((f) => [f.code, f.output]),
    [
      ['end-hold', '16:9'],
      ['error', '9:16'],
    ],
  )

  lines.length = 0
  const json = await eachVariant(
    { root, variant: '16:9,9:16' },
    async (flags, out) => {
      out.result({ size: flags.variant === '9:16' ? [1080, 1920] : [1920, 1080] })
      return EXIT.ok
    },
    { json: true },
  )
  assert.equal(json, EXIT.ok)
  assert.deepEqual(JSON.parse(lines.join('\n')), {
    variants: [
      { variant: '16:9', size: [1920, 1080] },
      { variant: '9:16', size: [1080, 1920] },
    ],
  })
  await assert.rejects(
    eachVariant({ root, variant: '16:9,9:16' }, async () => EXIT.ok, { one: 'only one' }),
    /only one/,
  )
  findings.length = 0
})
