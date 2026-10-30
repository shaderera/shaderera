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

// Throws on a key that is not a range: a value that is not finite, a softness or a hue width
// below 0, or a low above its high. Returns the key.
const checked = (key: Key) => {
  const fail = (what: string) => {
    throw new Error(`color-qualifier: ${what}`)
  }
  const finite = (name: string, v: number | undefined) => {
    if (v !== undefined && !Number.isFinite(v)) fail(`${name} must be finite, not ${v}`)
  }
  const soft = (name: string, v: number | undefined) => {
    finite(name, v)
    if ((v ?? 0) < 0) fail(`${name} must be 0 or more, not ${v}`)
  }
  const { hue, saturation, luma } = key
  if (hue) {
    finite('hue centreDeg', hue.centreDeg)
    soft('hue widthDeg', hue.widthDeg)
    soft('hue softnessDeg', hue.softnessDeg)
  }
  for (const [name, r] of [
    ['saturation', saturation],
    ['luma', luma],
  ] as const) {
    if (!r) continue
    finite(`${name} low`, r.low)
    finite(`${name} high`, r.high)
    soft(`${name} softness`, r.softness)
    if (r.low > r.high) fail(`${name} low ${r.low} is above its high ${r.high}`)
  }
  return key
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
  checked(key)
  const [r, g, b] = rgb
  let m = 1
  if (key.hue) {
    const { centreDeg, widthDeg, softnessDeg } = key.hue
    const d = Math.abs(((((hueOf(rgb) - centreDeg + 180) % 360) + 360) % 360) - 180)
    m *= within(d, 0, widthDeg / 2, softnessDeg ?? 0)
  }
  if (key.saturation) {
    const { low, high, softness } = key.saturation
    const hi = Math.max(r, g, b)
    // Past 1 only with a channel below 0, out of gamut: as saturated as a colour gets, so 1.
    const s = hi > 0 ? Math.min((hi - Math.min(r, g, b)) / hi, 1) : 0
    m *= within(s, low, high, softness ?? 0)
  }
  if (key.luma) {
    const { low, high, softness } = key.luma
    m *= within(0.2126 * r + 0.7152 * g + 0.0722 * b, low, high, softness ?? 0)
  }
  return m
}

/**
 * The key as qualifier.wgsl.ts's `QualifierKey` uniform, 48 bytes: hue [centre, half width,
 * softness, 0] in degrees, then saturation and luma [low, high, softness, 0].
 */
export const keyUniform = (key: Key) => {
  const range = (r: Range | undefined) =>
    r ? [r.low, r.high, r.softness ?? 0, 0] : [-ALL, ALL, 0, 0]
  const { hue } = checked(key)
  return new Float32Array([
    ...(hue ? [hue.centreDeg, hue.widthDeg / 2, hue.softnessDeg ?? 0, 0] : [0, 180, 0, 0]),
    ...range(key.saturation),
    ...range(key.luma),
  ])
}
