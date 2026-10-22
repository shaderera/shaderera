import type { Frame, Layer, Manifest, Range } from './protocol.ts'

/** Bytes or a texture that do not say how their alpha is stored. */
const undeclared = (layer: object) => {
  const color = (layer as { color: unknown }).color
  const texture = typeof GPUTexture !== 'undefined' && color instanceof GPUTexture
  return !('alpha' in layer) && (ArrayBuffer.isView(color) || texture)
}

/**
 * A Frame as its flat bottom-to-top list of layers. Bytes or a texture without `alpha` are taken
 * as straight, the same in every host.
 */
export const flattenFrame = (frame: Frame): readonly Layer[] => {
  const layers: readonly unknown[] = Array.isArray(frame) ? frame : [frame]
  for (const layer of layers) {
    if (Array.isArray(layer)) {
      throw new TypeError(
        'A Frame is one Layer or a flat array of Layers; nesting is not part of the protocol.',
      )
    }
    if (layer === null || typeof layer !== 'object' || !('color' in layer)) {
      throw new TypeError('Every Layer in a Frame needs a color.')
    }
  }
  return (layers as readonly Layer[]).map((l) => (undeclared(l) ? { ...l, alpha: 'straight' } : l))
}

/**
 * A final render's layers, refused if any says it is not final (`final: false`, a progressive
 * preview): a repeatable unfinished frame must never pass as a capture. Preview takes them as
 * they are.
 */
export const finalOnly = (
  layers: readonly Layer[],
  intent: 'preview' | 'final',
  t: number,
): readonly Layer[] => {
  if (intent !== 'final') return layers
  const unfinished = layers.filter((l) => l.final === false).map((l) => l.name ?? 'unnamed')
  if (unfinished.length > 0)
    throw new Error(
      `The final render at t=${t} returned an unfinished layer (${unfinished.join(', ')}: final: false). A final render must resolve its layers before it returns.`,
    )
  return layers
}

/** What a host reports of a rendered layer: its `name` and `final`, only those it set. */
export const layerInfo = ({ name, final }: Layer): { name?: string; final?: boolean } => ({
  ...(name !== undefined ? { name } : {}),
  ...(final !== undefined ? { final } : {}),
})

/** The float formats a layer with `light` may be: the light passes 1.0. */
const LIGHT_FORMATS: readonly string[] = ['rgba16float', 'rgba32float']

/**
 * A render's layers, refused if one declares `light` it cannot carry: on anything but an
 * `rgba16float` or `rgba32float` texture, or in an SDR render, where the film maps its own light
 * down (decision 0023; never a clamp). Without `light` the layers pass as they are.
 */
export const lightChecked = (layers: readonly Layer[], range: Range): readonly Layer[] => {
  for (const [i, layer] of layers.entries()) {
    const light = (layer as { light?: unknown }).light
    if (light === undefined) continue
    const named = `Layer ${layer.name ?? i}`
    const color = (layer as { color: unknown }).color
    const format =
      typeof GPUTexture !== 'undefined' && color instanceof GPUTexture ? color.format : undefined
    if (format === undefined || !LIGHT_FORMATS.includes(format))
      throw new Error(
        `${named} declares light, but only a GPUTexture of rgba16float or rgba32float carries it${format ? `, not ${format}` : ''}.`,
      )
    const { transfer, primaries } = light as { transfer?: unknown; primaries?: unknown }
    if (
      !(transfer === 'linear' || transfer === 'pq') ||
      !(primaries === 'bt709' || primaries === 'bt2020')
    )
      throw new Error(
        `${named}'s light must be { transfer: 'linear' | 'pq', primaries: 'bt709' | 'bt2020' }.`,
      )
    if (range === 'sdr')
      throw new Error(
        `${named} declares ${transfer} light, and this render is SDR: map the light down to SDR in the film (its own code or look-tonemap) for range sdr; light passes only in an hdr10 render.`,
      )
  }
  return layers
}

/**
 * The range a host opens a source in (`host.range`): `sdr` unless asked. `hdr10` needs the
 * manifest's `hdr10` block and a GPUDevice in every host (decision 0023).
 */
export const rangeOf = (manifest: Manifest, range: Range | undefined, gpu: unknown): Range => {
  if (range === undefined || range === 'sdr') return 'sdr'
  if (range !== 'hdr10') throw new Error(`A range is "sdr" or "hdr10", not ${String(range)}.`)
  if (!manifest.hdr10)
    throw new Error(
      'An hdr10 render needs the hdr10 block in shaderera.json: { mastering: { peak, min, primaries }, dither }.',
    )
  if (!gpu)
    throw new Error(
      "An hdr10 render needs a GPUDevice in every host, and this one has none: the Node host needs the project's `webgpu` (its Skia path is SDR only), a browser needs WebGPU.",
    )
  return range
}
