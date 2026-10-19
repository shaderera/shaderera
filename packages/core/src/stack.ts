import type { Frame, Layer } from './protocol.ts'

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
