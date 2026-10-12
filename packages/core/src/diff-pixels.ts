/** How two RGBA images differ, in channel units (0 to 255). */
export type PixelDiff = {
  readonly pixels: number
  readonly differing: number
  readonly max: number
  readonly mean: number
  readonly channels: readonly [number, number, number, number]
}

type Bytes = Uint8Array | Uint8ClampedArray

/** Compares two RGBA byte arrays; a pixel differs when a channel moves by more than threshold. */
export const diffPixels = (a: Bytes, b: Bytes, options: { threshold?: number } = {}): PixelDiff => {
  if (a.length !== b.length || a.length % 4 !== 0) {
    throw new Error(`Cannot compare ${a.length} bytes with ${b.length} bytes of RGBA.`)
  }
  const threshold = options.threshold ?? 0
  const sums: [number, number, number, number] = [0, 0, 0, 0]
  let differing = 0
  let max = 0
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0
    for (let c = 0; c < 4; c++) {
      const d = Math.abs((a[i + c] as number) - (b[i + c] as number))
      sums[c] = (sums[c] as number) + d
      if (d > worst) worst = d
    }
    if (worst > threshold) differing++
    if (worst > max) max = worst
  }
  const pixels = a.length / 4
  const per = (s: number) => (pixels === 0 ? 0 : s / pixels)
  return {
    pixels,
    differing,
    max,
    mean: per((sums[0] + sums[1] + sums[2] + sums[3]) / 4),
    channels: [per(sums[0]), per(sums[1]), per(sums[2]), per(sums[3])],
  }
}
