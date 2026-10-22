import type { Layer, Open } from '@shaderera/core'

/** PQ's 1.0 over BT.2100's linear 1.0: a linear layer's value at 10 000 cd/m². */
const PEAK = 10000 / 203

/**
 * The HDR exactness fixture (docs/adr/0023, decision 4), 1024 wide so a row holds every 10-bit
 * code, as three layers bottom to top:
 * - PQ code values in BT.2020: rows 0–15 ramps over all 1024 codes, near-black codes and hard
 *   colour edges a pixel apart; mid grey below, under the other layers.
 * - linear light in BT.2020, premultiplied: rows 16–31 the primaries and secondaries at PQ's peak,
 *   a smooth ramp to it, near-black light, and a colour at half alpha.
 * - 8-bit SDR graphics, straight: rows 32–63 white (Graphics White), brand colours, a colour at
 *   every alpha over the grey, and every byte of a grey ramp.
 */
export const fixture = (width: number, height: number) => {
  const pq = new Float32Array(width * height * 4)
  const linear = new Float32Array(width * height * 4)
  const graphics = new Uint8Array(width * height * 4)
  const code = (c: number) => (c % 1024) / 1023
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const band = y >> 2
      // PQ, opaque.
      const p =
        band === 0
          ? [code(x), code(x), code(x)]
          : band === 1
            ? [code(x), code(1023 - x), code(x * 389)]
            : band === 2
              ? [code(x % 16), code((x >> 4) % 16), code(x >> 8)]
              : band === 3
                ? y % 2 === 0
                  ? x % 2 === 0
                    ? [1, 0, 0]
                    : [0, 1, 0]
                  : (x >> 1) % 2 === 0
                    ? [0, 0, 1]
                    : [1, 1, 0]
                : [code(512), code(512), code(512)]
      pq.set([...p, 1], i)
      // Linear, premultiplied; nothing above row 16 or below row 31.
      const t = x / (width - 1)
      const segment = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [0, 1, 1],
        [1, 0, 1],
        [1, 1, 0],
        [1, 1, 1],
        [0, 0, 0],
      ][Math.floor((x * 8) / width)] as number[]
      const l =
        band === 4
          ? [...segment.map((v) => v * PEAK), 1]
          : band === 5
            ? [t * t * PEAK, t * t * t * PEAK, t * 0.5, 1]
            : band === 6
              ? [x * 1e-6, x * 2e-6, x * 1e-7, 1]
              : band === 7
                ? [2 * 0.5, 0.5 * 0.5, 0.1 * 0.5, 0.5]
                : [0, 0, 0, 0]
      linear.set(l, i)
      // 8-bit SDR graphics, straight; nothing above row 32.
      const g =
        y < 32
          ? [0, 0, 0, 0]
          : y < 40
            ? [255, 255, 255, 255]
            : y < 48
              ? (
                  [
                    [230, 40, 90],
                    [20, 120, 220],
                    [250, 200, 0],
                    [0, 160, 80],
                  ][(x >> 6) % 4] as number[]
                ).concat(255)
              : y < 56
                ? [230, 40, 90, x >> 2]
                : [x >> 2, x >> 2, x >> 2, 255]
      graphics.set(g, i)
    }
  return { pq, linear, graphics }
}

/**
 * The fixture as a film's frame: two float textures that declare their light, and bytes. Its own
 * SDR version (an SDR render, decision 0023) keeps the graphics alone: the film maps its light down
 * by leaving it out, so nothing declares light there.
 */
const open: Open = ({ gpu, manifest, range }) => {
  const { width, height } = manifest
  const { pq, linear, graphics } = fixture(width, height)
  if (range !== 'hdr10') {
    const sdr: Layer[] = [{ color: graphics, alpha: 'straight', name: 'graphics' }]
    return { render: async () => sdr }
  }
  if (!gpu) throw new Error('The HDR fixture needs WebGPU.')
  const texture = (data: Float32Array) => {
    const t = gpu.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    gpu.queue.writeTexture(
      { texture: t },
      data as Float32Array<ArrayBuffer>,
      { bytesPerRow: width * 16 },
      [width, height],
    )
    return t
  }
  const layers: Layer[] = [
    {
      color: texture(pq),
      alpha: 'straight',
      light: { transfer: 'pq', primaries: 'bt2020' },
      name: 'pq',
    },
    {
      color: texture(linear),
      alpha: 'premultiplied',
      light: { transfer: 'linear', primaries: 'bt2020' },
      name: 'linear',
    },
    { color: graphics, alpha: 'straight', name: 'graphics' },
  ]
  return { render: async () => layers }
}
export default open
