// .cube LUTs (the Adobe and Resolve format) read into plain data and written back, and applied on
// the CPU with the same values lut.wgsl.ts gives in a shader: tetrahedral for a 3D table, linear
// per channel for a 1D one. The LUT's input and output spaces are its author's; nothing here
// converts them. lutTexture puts a LUT on the GPU for the WGSL.

type Rgb = readonly [number, number, number]

/** A LUT as a .cube file states it. */
export type Lut = {
  /** The file's TITLE, when it has one. */
  readonly title?: string
  /** 3 for a 3D table (LUT_3D_SIZE), 1 for a curve per channel (LUT_1D_SIZE). */
  readonly dimensions: 1 | 3
  /** Entries along each axis. */
  readonly size: number
  /** The input that maps to the table's first and last entries, per channel: 0 and 1 by default. */
  readonly domainMin: Rgb
  readonly domainMax: Rgb
  /** RGB triples as the file lists them: size³ for 3D (red fastest, then green, then blue), size for 1D. */
  readonly table: Float64Array
}

const MAX_SIZE = { 1: 65536, 3: 256 } as const

const numbers = (words: string[], line: number, what: string) => {
  const v = words.map(Number)
  if (v.length !== 3 || v.some((x) => !Number.isFinite(x)))
    throw new Error(`.cube line ${line}: ${what} needs three numbers, not "${words.join(' ')}"`)
  return v as unknown as Rgb
}

/** A .cube file's text to a LUT. Throws on a file that is not one, saying what is wrong. */
export const readCube = (text: string): Lut => {
  let title: string | undefined
  const sizes: { 1?: number; 3?: number } = {}
  let domainMin: Rgb = [0, 0, 0]
  let domainMax: Rgb = [1, 1, 1]
  const rows: number[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim()
    if (s === '' || s.startsWith('#')) return
    const [key = '', ...rest] = s.split(/\s+/)
    if (/^[-+.\d]/.test(key)) {
      rows.push(...numbers([key, ...rest], i + 1, 'a row'))
      return
    }
    if (key === 'TITLE')
      title = s
        .slice(5)
        .trim()
        .replace(/^"(.*)"$/, '$1')
    else if (key === 'LUT_1D_SIZE' || key === 'LUT_3D_SIZE') {
      const d = key === 'LUT_1D_SIZE' ? 1 : 3
      const n = Number(rest[0])
      if (!Number.isInteger(n) || n < 2 || n > MAX_SIZE[d])
        throw new Error(`.cube: ${key} ${rest[0]} is out of range: 2–${MAX_SIZE[d]}`)
      sizes[d] = n
    } else if (key === 'DOMAIN_MIN') domainMin = numbers(rest, i + 1, key)
    else if (key === 'DOMAIN_MAX') domainMax = numbers(rest, i + 1, key)
    // Resolve's form of the domain: one range for all three channels.
    else if (key === 'LUT_1D_INPUT_RANGE' || key === 'LUT_3D_INPUT_RANGE') {
      const [lo = Number.NaN, hi = Number.NaN] = rest.map(Number)
      domainMin = [lo, lo, lo]
      domainMax = [hi, hi, hi]
    } else throw new Error(`.cube line ${i + 1}: ${key} is not a .cube keyword`)
  })
  if (sizes[1] && sizes[3])
    throw new Error('.cube: both LUT_1D_SIZE and LUT_3D_SIZE; a file with a shaper is not read')
  const dimensions = sizes[3] ? 3 : 1
  const size = sizes[dimensions]
  if (!size) throw new Error('.cube: no LUT_3D_SIZE or LUT_1D_SIZE')
  if (domainMin.some((lo, c) => !((domainMax[c] ?? Number.NaN) > lo)))
    throw new Error(
      `.cube: DOMAIN_MAX must be above DOMAIN_MIN, per channel: ${domainMin} to ${domainMax}`,
    )
  const entries = dimensions === 3 ? size ** 3 : size
  if (rows.length !== entries * 3)
    throw new Error(
      `.cube: ${dimensions === 3 ? 'LUT_3D_SIZE' : 'LUT_1D_SIZE'} ${size} needs ${entries} rows, and the file has ${rows.length / 3}`,
    )
  return {
    ...(title === undefined ? {} : { title }),
    dimensions,
    size,
    domainMin,
    domainMax,
    table: new Float64Array(rows),
  }
}

/** A LUT to .cube text, every number as JavaScript writes it, so reading it back gives the same LUT. */
export const writeCube = (lut: Lut): string => {
  const head = [
    ...(lut.title === undefined ? [] : [`TITLE "${lut.title}"`]),
    `LUT_${lut.dimensions}D_SIZE ${lut.size}`,
    `DOMAIN_MIN ${lut.domainMin.join(' ')}`,
    `DOMAIN_MAX ${lut.domainMax.join(' ')}`,
  ]
  const rows: string[] = []
  for (let i = 0; i < lut.table.length; i += 3)
    rows.push(`${lut.table[i]} ${lut.table[i + 1]} ${lut.table[i + 2]}`)
  return `${[...head, ...rows].join('\n')}\n`
}

/**
 * A colour through the LUT, in the LUT's own spaces, clamped to its domain first. 3D: tetrahedral,
 * the cell cut into six tetrahedra along its grey diagonal and the four corners of the one the
 * colour is in blended. 1D: each channel linear between the two entries either side.
 */
export const applyLut = (lut: Lut, rgb: Rgb): [number, number, number] => {
  const n = lut.size
  const entry = (k: number, c: number) => lut.table[k * 3 + c] ?? 0
  // A channel's place on the grid: the entry at or below it, and the fraction past that one.
  const place = (c: 0 | 1 | 2) => {
    const lo = lut.domainMin[c]
    const p = Math.min(Math.max((rgb[c] - lo) / (lut.domainMax[c] - lo), 0), 1) * (n - 1)
    const i = Math.min(Math.floor(p), n - 2)
    return [i, p - i] as const
  }
  const [ir, fr] = place(0)
  const [ig, fg] = place(1)
  const [ib, fb] = place(2)
  if (lut.dimensions === 1) {
    const mix = (i: number, f: number, c: number) => entry(i, c) * (1 - f) + entry(i + 1, c) * f
    return [mix(ir, fr, 0), mix(ig, fg, 1), mix(ib, fb, 2)]
  }
  // From c000 to c111 one axis at a time, the axis of the largest fraction first: `a` and `b` are
  // the corners on the way, `w` the fractions in that order.
  type Step = readonly [number, number, number]
  let a: Step, b: Step, w: Step
  if (fr >= fg) {
    if (fg >= fb)
      [a, b, w] = [
        [1, 0, 0],
        [1, 1, 0],
        [fr, fg, fb],
      ]
    else if (fr >= fb)
      [a, b, w] = [
        [1, 0, 0],
        [1, 0, 1],
        [fr, fb, fg],
      ]
    else
      [a, b, w] = [
        [0, 0, 1],
        [1, 0, 1],
        [fb, fr, fg],
      ]
  } else if (fb >= fg)
    [a, b, w] = [
      [0, 0, 1],
      [0, 1, 1],
      [fb, fg, fr],
    ]
  else if (fb >= fr)
    [a, b, w] = [
      [0, 1, 0],
      [0, 1, 1],
      [fg, fb, fr],
    ]
  else
    [a, b, w] = [
      [0, 1, 0],
      [1, 1, 0],
      [fg, fr, fb],
    ]
  const corner = (s: Step) => ir + s[0] + (ig + s[1]) * n + (ib + s[2]) * n * n
  const [k0, ka, kb, k1] = [corner([0, 0, 0]), corner(a), corner(b), corner([1, 1, 1])]
  const out = (c: number) =>
    entry(k0, c) +
    w[0] * (entry(ka, c) - entry(k0, c)) +
    w[1] * (entry(kb, c) - entry(ka, c)) +
    w[2] * (entry(k1, c) - entry(kb, c))
  return [out(0), out(1), out(2)]
}

/**
 * The LUT as a texture of `device` for lut.wgsl.ts: a 3D table as a size³ 3D texture, a 1D one as
 * a size × 1 2D texture; rgba32float, read with textureLoad, so no sampler.
 */
export const lutTexture = (device: GPUDevice, lut: Lut): GPUTexture => {
  const n = lut.size
  const three = lut.dimensions === 3
  if (!three && n > device.limits.maxTextureDimension2D)
    throw new Error(
      `lutTexture: LUT_1D_SIZE ${n} is wider than this GPU's textures (${device.limits.maxTextureDimension2D})`,
    )
  const texels = three ? n ** 3 : n
  const data = new Float32Array(texels * 4)
  for (let k = 0; k < texels; k++) data.set(lut.table.subarray(k * 3, k * 3 + 3), k * 4)
  const size = three ? [n, n, n] : [n, 1]
  const texture = device.createTexture({
    size,
    dimension: three ? '3d' : '2d',
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: n * 16, rowsPerImage: three ? n : 1 },
    size,
  )
  return texture
}
