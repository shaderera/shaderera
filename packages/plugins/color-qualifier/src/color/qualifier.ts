// A hue, saturation and luma key to a soft matte, 0–1: the product of three soft ranges, each one
// left out passing everything. qualifier.wgsl.ts gives the same matte in a shader, from the
// uniform keyUniform packs. Hue and saturation are HSV's, the hue as color-curves' hueOf reads it,
// so a hue range keys the pixels a hue curve at those hues turns; luma is Rec.709's.

type Rgb = readonly [number, number, number]

/** Values from `low` to `high` pass; `softness` more each side ramps to 0 (smoothstep); 0 is a hard key. */
export type Range = { readonly low: number; readonly high: number; readonly softness?: number }

/** Hues within `widthDeg / 2` of `centreDeg` pass, around 360°; `softnessDeg` more each side ramps to 0. */
export type HueRange = {
  readonly centreDeg: number
  readonly widthDeg: number
  readonly softnessDeg?: number
}

/** A key: HSV hue, HSV saturation (0–1) and Rec.709 luma. A range left out passes everything. */
export type Key = {
  readonly hue?: HueRange
  readonly saturation?: Range
  readonly luma?: Range
}

// Far past any value: the bounds of a range left out, which then passes everything on the GPU too.
const ALL = 1e30

const checked = (s: number | undefined, what: string) => {
  if ((s ?? 0) < 0) throw new Error(`color-qualifier: ${what} softness must be 0 or more, not ${s}`)
  return s ?? 0
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

// 1 from low to high, smoothstep to 0 over s outside each; a hard step when s is 0.
const within = (x: number, low: number, high: number, s: number) =>
  s > 0
    ? smoothstep(low - s, low, x) * (1 - smoothstep(high, high + s, x))
    : x >= low && x <= high
      ? 1
      : 0

/** The HSV hue in degrees, 0–360, 0 for a grey: color-curves' hueOf, repeated so a key needs no LUT. */
const hueOf = ([r, g, b]: Rgb) => {
  const hi = Math.max(r, g, b)
  const chroma = hi - Math.min(r, g, b)
  if (chroma <= 0) return 0
  const h = hi === r ? (g - b) / chroma : hi === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
  return (((h * 60) % 360) + 360) % 360
}

/**
 * The matte of a colour under `key`, 0–1: the product of its hue, saturation and luma ranges.
 * A grey's hue is 0° (red), so a hue range over red keys greys unless a saturation range drops them.
 */
export const qualify = (rgb: Rgb, key: Key): number => {
  const [r, g, b] = rgb
  let m = 1
  if (key.hue) {
    const { centreDeg, widthDeg, softnessDeg } = key.hue
    const d = Math.abs(((((hueOf(rgb) - centreDeg + 180) % 360) + 360) % 360) - 180)
    m *= within(d, 0, widthDeg / 2, checked(softnessDeg, 'hue'))
  }
  if (key.saturation) {
    const { low, high, softness } = key.saturation
    const hi = Math.max(r, g, b)
    const s = hi > 0 ? (hi - Math.min(r, g, b)) / hi : 0
    m *= within(s, low, high, checked(softness, 'saturation'))
  }
  if (key.luma) {
    const { low, high, softness } = key.luma
    m *= within(0.2126 * r + 0.7152 * g + 0.0722 * b, low, high, checked(softness, 'luma'))
  }
  return m
}

/**
 * The key as qualifier.wgsl.ts's `QualifierKey` uniform, 48 bytes: hue [centre, half width,
 * softness, 0] in degrees, then saturation and luma [low, high, softness, 0].
 */
export const keyUniform = (key: Key) => {
  const range = (r: Range | undefined, what: string) =>
    r ? [r.low, r.high, checked(r.softness, what), 0] : [-ALL, ALL, 0, 0]
  const { hue } = key
  return new Float32Array([
    ...(hue
      ? [hue.centreDeg, hue.widthDeg / 2, checked(hue.softnessDeg, 'hue'), 0]
      : [0, 180, 0, 0]),
    ...range(key.saturation, 'saturation'),
    ...range(key.luma, 'luma'),
  ])
}
