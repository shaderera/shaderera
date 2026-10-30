// A frame measured the way a colourist reads scopes, as numbers: levels, histogram, waveform,
// parade, balance per tonal band, and a vectorscope summary. Numbers only; it never says good or bad.

/** Straight RGBA, rows from the top: core's DecodedImage, a canvas's ImageData, a footage frame. */
export type ScopeFrame = {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array | Uint8ClampedArray | Uint16Array
  /** 16: values 0–65535, as a 16-bit PNG decodes. When left out, 16 for a Uint16Array, else 8. */
  readonly bits?: 8 | 16
}

/** A channel's levels, 0–1; `clipped` and `crushed` are % of pixels at ≥ 250 and ≤ 5 of 255. */
export type Levels = {
  mean: number
  /** The 0.5th percentile. */
  black: number
  /** The 99.5th percentile. */
  white: number
  clipped: number
  crushed: number
}

/** A column band's 5th, 50th and 95th percentiles, 0–1. */
export type Spread = { low: number; median: number; high: number }

/** A tonal band's share of the pixels (%), and its mean R − G and B − G, 0–1. */
export type Balance = { share: number; rg: number; bg: number }

export type Scopes = {
  luma: 'bt709' | 'bt2020'
  pixels: number
  /** `y` is luma: its black and white are the frame's black and white points. */
  levels: { r: Levels; g: Levels; b: Levels; y: Levels }
  /** % of pixels in each of `bins` equal bins, from black. */
  histogram: { bins: number; r: number[]; g: number[]; b: number[]; y: number[] }
  /** Luma by column band, left to right. */
  waveform: Spread[]
  parade: { r: Spread[]; g: Spread[]; b: Spread[] }
  /** By luma: shadows under 1/3, highlights from 2/3. null: no pixel in the band. */
  balance: { shadows: Balance | null; midtones: Balance | null; highlights: Balance | null }
  vectorscope: {
    /** The mean chroma's hue, degrees from +Cb towards +Cr (0 up to 360): subject colour and cast together; null when `cast` is under 0.004 (one 8-bit code). */
    hueDeg: number | null
    /** The mean chroma's distance from the centre. A cast proper is read from `balance` in the neutrals. */
    cast: number
    /** Each pixel's distance from the centre in CbCr: 0 grey, about 0.5 a primary. */
    saturation: { mean: number; std: number }
    /** Skin-hued pixels (not people): within 15° of the skin-tone line (123°) at a saturation of 0.02–0.3, their % and mean angle from it. */
    skin: { share: number; offsetDeg: number | null }
  }
}

/** Kr and Kb. */
const K = { bt709: [0.2126, 0.0722], bt2020: [0.2627, 0.0593] } as const
const SKIN_DEG = 123
const DEG = 180 / Math.PI

const add = (a: { [i: number]: number }, i: number, d: number) => {
  a[i] = (a[i] as number) + d
}
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 || 0
const r2 = (v: number) => Math.round(v * 100) / 100 || 0
const r1 = (v: number) => Math.round(v * 10) / 10 || 0

/** The smallest 8-bit code that `p` of a 256-bin histogram's `n` values reach, 0–1. */
const percentile = (h: Uint32Array, o: number, n: number, p: number) => {
  let cum = 0
  for (let i = 0; i < 256; i++) {
    cum += h[o + i] as number
    if (cum >= p * n && cum > 0) return r4(i / 255)
  }
  return 0
}
const spread = (h: Uint32Array, o: number, n: number): Spread => ({
  low: percentile(h, o, n, 0.05),
  median: percentile(h, o, n, 0.5),
  high: percentile(h, o, n, 0.95),
})

/** The frame's scopes; `bands` column bands for the waveform and parade (8), `bins` for the histogram (16), each floored and kept to 1–256. */
export const scopes = (
  frame: ScopeFrame,
  options: { luma?: 'bt709' | 'bt2020'; bands?: number; bins?: number } = {},
): Scopes => {
  const { width, height, data } = frame
  if (data.length !== width * height * 4)
    throw new Error(`${data.length} values are not a ${width} × ${height} RGBA frame`)
  const luma = options.luma ?? 'bt709'
  const [kr, kb] = K[luma]
  const kg = 1 - kr - kb
  const count = (v: number, most: number) => Math.max(1, Math.min(Math.floor(v), most))
  const bins = count(options.bins ?? 16, 256)
  const bands = count(options.bands ?? 8, Math.min(256, width))
  const scale = (frame.bits ?? (data instanceof Uint16Array ? 16 : 8)) === 16 ? 1 / 257 : 1
  const n = width * height

  // Channels 0–3 are R, G, B, luma: a 256-bin histogram each, and one per column band.
  const hist = new Uint32Array(4 * 256)
  const bandHist = new Uint32Array(bands * 4 * 256)
  const sum = new Float64Array(4)
  const clipped = new Uint32Array(4)
  const crushed = new Uint32Array(4)
  const tone = [0, 1, 2].map(() => ({ n: 0, rg: 0, bg: 0 }))
  let cb = 0
  let cr = 0
  let sat = 0
  let sat2 = 0
  let skin = 0
  let skinDeg = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4
      const band = Math.floor((x * bands) / width) * 1024
      const R = (data[k] as number) * scale
      const G = (data[k + 1] as number) * scale
      const B = (data[k + 2] as number) * scale
      const Y = kr * R + kg * G + kb * B
      const v = [R, G, B, Y]
      for (let c = 0; c < 4; c++) {
        const code = Math.min(255, Math.max(0, Math.round(v[c] as number)))
        add(hist, c * 256 + code, 1)
        add(bandHist, band + c * 256 + code, 1)
        add(sum, c, v[c] as number)
        if (code >= 250) add(clipped, c, 1)
        if (code <= 5) add(crushed, c, 1)
      }
      const t = tone[Y < 85 ? 0 : Y < 170 ? 1 : 2] as { n: number; rg: number; bg: number }
      t.n++
      t.rg += (R - G) / 255
      t.bg += (B - G) / 255
      const pb = (B - Y) / 255 / (2 * (1 - kb))
      const pr = (R - Y) / 255 / (2 * (1 - kr))
      const s = Math.hypot(pb, pr)
      cb += pb
      cr += pr
      sat += s
      sat2 += s * s
      if (s >= 0.02 && s <= 0.3) {
        const off = ((((Math.atan2(pr, pb) * DEG - SKIN_DEG) % 360) + 540) % 360) - 180
        if (Math.abs(off) <= 15) {
          skin++
          skinDeg += off
        }
      }
    }
  }

  const levels = (c: number): Levels => ({
    mean: r4((sum[c] as number) / n / 255),
    black: percentile(hist, c * 256, n, 0.005),
    white: percentile(hist, c * 256, n, 0.995),
    clipped: r2((100 * (clipped[c] as number)) / n),
    crushed: r2((100 * (crushed[c] as number)) / n),
  })
  const coarse = (c: number) => {
    const out = Array<number>(bins).fill(0)
    for (let i = 0; i < 256; i++)
      add(out, Math.floor((i * bins) / 256), hist[c * 256 + i] as number)
    return out.map((v) => r2((100 * v) / n))
  }
  const columns = (c: number) =>
    Array.from({ length: bands }, (_, i) => {
      const o = i * 1024 + c * 256
      let m = 0
      for (let j = 0; j < 256; j++) m += bandHist[o + j] as number
      return spread(bandHist, o, m)
    })
  const balance = (i: number): Balance | null => {
    const t = tone[i] as { n: number; rg: number; bg: number }
    return t.n ? { share: r2((100 * t.n) / n), rg: r4(t.rg / t.n), bg: r4(t.bg / t.n) } : null
  }
  const mean = sat / n
  const chroma = Math.hypot(cb / n, cr / n)
  const hue = r1(r1(Math.atan2(cr, cb) * DEG + 360) % 360)
  return {
    luma,
    pixels: n,
    levels: { r: levels(0), g: levels(1), b: levels(2), y: levels(3) },
    histogram: { bins, r: coarse(0), g: coarse(1), b: coarse(2), y: coarse(3) },
    waveform: columns(3),
    parade: { r: columns(0), g: columns(1), b: columns(2) },
    balance: { shadows: balance(0), midtones: balance(1), highlights: balance(2) },
    vectorscope: {
      hueDeg: chroma < 0.004 ? null : hue,
      cast: r4(chroma),
      saturation: { mean: r4(mean), std: r4(Math.sqrt(Math.max(0, sat2 / n - mean * mean))) },
      skin: { share: r2((100 * skin) / n), offsetDeg: skin ? r1(skinDeg / skin) : null },
    },
  }
}
