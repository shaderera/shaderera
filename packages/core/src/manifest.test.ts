import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkManifest, withVariant } from './manifest.ts'

const good = { entry: 'main.ts', fps: 30, duration: 2, width: 64, height: 32 }

test('checkManifest accepts a valid manifest', () => {
  const full = { ...good, $schema: 'x', params: {}, seed: 3, sequential: true }
  assert.deepEqual(checkManifest(full), full)
})

test('checkManifest lists every problem', () => {
  assert.throws(() => checkManifest({ ...good, fps: 0, width: 1.5, scenes: [] }), {
    message:
      'shaderera.json: fps must be a positive number or a fraction such as "24000/1001"; width must be a positive integer; unknown key "scenes"',
  })
  assert.throws(
    () => checkManifest({ ...good, sequential: false }),
    /sequential must be true or a whole number/,
  )
  assert.throws(() => checkManifest({ ...good, sequential: 0 }), /sequential must be true or/)
  assert.throws(() => checkManifest({ ...good, sequential: 2.5 }), /sequential must be true or/)
  checkManifest({ ...good, sequential: 8 })
  assert.throws(() => checkManifest({ ...good, host: 'gpu' }), /host must be "node" or "browser"/)
  assert.throws(() => checkManifest({ ...good, dom: './d.ts' }), /dom needs the browser host/)
  checkManifest({ ...good, dom: './d.ts', host: 'browser' })
  // An NTSC rate is its fraction, however it is written.
  assert.equal(checkManifest({ ...good, fps: 29.97 }).fps, 30000 / 1001)
  assert.equal(checkManifest({ ...good, fps: '24000/1001' }).fps, 24000 / 1001)
  assert.throws(
    () => checkManifest({ ...good, dom: './d.ts', host: 'browser', domScale: 1.5 }),
    /domScale must be 1, 2, 3 or 4/,
  )
  assert.throws(() => checkManifest({ ...good, domScale: 2 }), /domScale needs dom/)
  assert.throws(() => checkManifest([]), /object/)
})

test('variants are designed outputs: sizes, lengths and params, checked like the manifest', () => {
  const variants = {
    portrait: { label: 'Vertical', width: 1080, height: 1920 },
    short: { duration: 6, params: { cta: 'Now' } },
  }
  assert.deepEqual(checkManifest({ ...good, variants }).variants, variants)
  assert.throws(
    () => checkManifest({ ...good, variants: { a: { width: 10.5, crop: true }, b: 3 } }),
    {
      message:
        'shaderera.json: variants.a.width must be a positive integer; variants.a: unknown key "crop"; variants.b must be an object',
    },
  )
})

test('withVariant applies a variant to the manifest and returns its params', () => {
  const m = checkManifest({
    ...good,
    variants: { portrait: { label: 'V', width: 1080, height: 1920, params: { cta: 'Go' } } },
  })
  const { manifest, params } = withVariant(m, 'portrait')
  assert.equal(manifest.width, 1080)
  assert.equal(manifest.height, 1920)
  assert.equal(manifest.duration, 2)
  assert.deepEqual(params, { cta: 'Go' })
  assert.deepEqual(withVariant(m), { manifest: m, params: {} })
  assert.throws(() => withVariant(m, 'square'), /no variant "square"/)
})
