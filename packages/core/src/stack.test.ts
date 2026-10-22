import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Frame, Layer, Manifest } from './protocol.ts'
import { flattenFrame, lightChecked, rangeOf } from './stack.ts'

// A stand-in for WebGPU's GPUTexture: only its format is read.
class Texture {
  format: string
  constructor(format: string) {
    this.format = format
  }
}
;(globalThis as { GPUTexture?: unknown }).GPUTexture = Texture
const texture = (format: string) => new Texture(format) as unknown as GPUTexture

const layer: Layer = { color: new Uint8Array(4), alpha: 'opaque' }

test('flattenFrame wraps a Layer and keeps a flat array', () => {
  assert.deepEqual(flattenFrame(layer), [layer])
  const stack = [layer, layer]
  assert.deepEqual(flattenFrame(stack), stack)
})

test('flattenFrame takes bytes without alpha as straight', () => {
  const bytes = { color: new Uint8Array(4) } as unknown as Frame
  assert.deepEqual(flattenFrame(bytes), [{ color: new Uint8Array(4), alpha: 'straight' }])
})

test('flattenFrame rejects nesting and layers without color', () => {
  assert.throws(() => flattenFrame([[layer]] as unknown as Frame), /nesting/)
  assert.throws(() => flattenFrame([{}] as unknown as Frame), TypeError)
})

test('a layer with light passes in an hdr10 render, on rgba16float or rgba32float only', () => {
  const light = { transfer: 'linear', primaries: 'bt2020' } as const
  const hdr: Layer[] = [
    layer,
    { color: texture('rgba16float'), alpha: 'premultiplied', light },
    {
      color: texture('rgba32float'),
      alpha: 'opaque',
      light: { transfer: 'pq', primaries: 'bt709' },
    },
  ]
  assert.equal(lightChecked(hdr, 'hdr10'), hdr)
  assert.throws(
    () =>
      lightChecked(
        [{ color: texture('rgba8unorm'), alpha: 'opaque', light, name: 'sky' }],
        'hdr10',
      ),
    {
      message:
        'Layer sky declares light, but only a GPUTexture of rgba16float or rgba32float carries it, not rgba8unorm.',
    },
  )
  assert.throws(
    () => lightChecked([layer, { color: new Uint8Array(4), alpha: 'opaque', light }], 'hdr10'),
    /^Error: Layer 1 declares light, but only a GPUTexture of rgba16float or rgba32float carries it\.$/,
  )
  assert.throws(
    () =>
      lightChecked(
        [
          {
            color: texture('rgba16float'),
            alpha: 'opaque',
            light: { transfer: 'hlg', primaries: 'bt2020' },
          } as unknown as Layer,
        ],
        'hdr10',
      ),
    /light must be \{ transfer: 'linear' \| 'pq'/,
  )
})

test('an SDR render refuses a layer with light, naming it, and passes every other layer', () => {
  const sdr: Layer[] = [layer, { color: texture('rgba16float'), alpha: 'opaque' }]
  assert.equal(lightChecked(sdr, 'sdr'), sdr)
  assert.throws(
    () =>
      lightChecked(
        [
          layer,
          {
            color: texture('rgba16float'),
            alpha: 'premultiplied',
            light: { transfer: 'pq', primaries: 'bt2020' },
            name: 'sun',
          },
        ],
        'sdr',
      ),
    /^Error: Layer sun declares pq light, and this render is SDR: map the light down/,
  )
})

test('host.range is sdr unless a job asks for hdr10, which needs the manifest block and a GPU', () => {
  const sdr: Manifest = { entry: 'main.ts', fps: 30, duration: 1, width: 8, height: 8 }
  const hdr: Manifest = {
    ...sdr,
    hdr10: { mastering: { peak: 1000, min: 0.005, primaries: 'p3-d65' }, dither: 'tpdf' },
  }
  const gpu = {}
  assert.equal(rangeOf(sdr, undefined, undefined), 'sdr')
  assert.equal(rangeOf(hdr, 'sdr', undefined), 'sdr')
  assert.equal(rangeOf(hdr, 'hdr10', gpu), 'hdr10')
  assert.throws(() => rangeOf(sdr, 'hdr10', gpu), /needs the hdr10 block in shaderera\.json/)
  assert.throws(
    () => rangeOf(hdr, 'hdr10', undefined),
    /needs a GPUDevice in every host, and this one has none: .*Skia path is SDR only/,
  )
  assert.throws(() => rangeOf(hdr, 'hdr' as never, gpu), /"sdr" or "hdr10", not hdr/)
})
