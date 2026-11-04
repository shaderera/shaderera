// A Lottie file's keyframes, read as written. The frame rate, the in and out points, the size, the
// layers, and every property of each layer's transform (`ks`) with its keyframes: time, value,
// hold, and the in and out bezier handles, per dimension when the file has them so. `valueAt`
// plays a property with the file's own curves and motion-eases' bezier solve. Nothing is fitted,
// named or smoothed. Shapes, masks, expressions, effects, markers and every field it does not know
// are listed in `unsupported`, never dropped silently. Pure functions of the file, so any t gives
// the same value at any time.

import { bezier, type Ease, hold, linear } from './eases.ts'

/** An easing handle as written: one x and y for every dimension, or one for all of them. */
export type LottieHandle = { x: number[]; y: number[] }

/** A keyframe as written. The move from it to the next key uses its `out` and `in` handles. */
export type LottieKey = {
  /** The file's frame, as written. */
  frame: number
  /** The same time in seconds: `frame / fr`. */
  t: number
  /** `s`: the value at this key. Absent only on an older file's last key, which ends on `e`. */
  value?: number[]
  /** `e`: the value the move ends on, written by older files (the next key's `s` wins). */
  end?: number[]
  /** `h`: the value holds until the next key, then jumps. */
  hold: boolean
  /** `o`: the handle leaving this key, the bezier's first point. */
  out?: LottieHandle
  /** `i`: the handle entering the next key, the bezier's second point. */
  in?: LottieHandle
  /** `to`: the path's tangent leaving this key, relative to `value` (position, anchor). */
  pathOut?: number[]
  /** `ti`: the path's tangent entering the next key, relative to the next value. */
  pathIn?: number[]
}

/** One property of a layer's transform. */
export type LottieProperty = {
  /** Where it is in the file: `layers[2].ks.p`. */
  path: string
  /** Lottie's name: a, p, px, py, pz, s, r, o, sk, sa, rx, ry, rz, or, or any other the file has. */
  name: string
  /** What the name means, in Lottie's units: 'position (px)', 'rotation (deg)'. */
  label: string
  animated: boolean
  /** The value when it is not animated; the first key's when it is. */
  value: number[]
  /** In time order, as written; empty when not animated. */
  keys: LottieKey[]
  /** `x`: an expression the file carries. Not run: it is listed in `unsupported`. */
  expression?: string
}

export type LottieLayer = {
  /** The layer's place in `layers`, top first. */
  index: number
  /** `ind`, which `parent` names. */
  ind?: number
  name: string
  /** `ty` as written, and what it is. */
  ty: number
  type: string
  /** `parent`: the `ind` of the layer whose transform this one sits in. Not composed here. */
  parent?: number
  /** `ip`, `op`: the frames it shows from and to (the out point not included), and in seconds. */
  ip: number
  op: number
  in: number
  out: number
  /** `st` and `sr`, as written; they time a precomp's contents, which are not read. */
  st: number
  sr: number
  /** `ddd`: a 3D layer. */
  threeD: boolean
  /** `hd`: hidden. */
  hidden: boolean
  /** The transform, by Lottie's name: `transform.p`, or `px` and `py` when position is split. */
  transform: Record<string, LottieProperty>
}

/** Something the file has that this reader does not read, and where. */
export type LottieUnsupported = {
  /** shapes, masks, expression, effects, time remap, parenting, precomp, track matte… */
  feature: string
  /** Where it is in the file: `layers[2].shapes`. */
  where: string
}

export type Lottie = {
  /** `v`: the version that wrote it, when it says. */
  version?: string
  name?: string
  /** `fr`: frames a second. Keyframe times are frames at this rate. */
  fr: number
  /** `ip`, `op`: the frames it plays from and to (the out point not included), and in seconds. */
  ip: number
  op: number
  in: number
  out: number
  /** `w`, `h`: the size in pixels. */
  width: number
  height: number
  /** `ddd`: a 3D composition. */
  threeD: boolean
  layers: LottieLayer[]
  /** Every feature present and not read. Empty means the transforms are the whole file. */
  unsupported: LottieUnsupported[]
}

type Obj = Record<string, unknown>

// Lookups by a name the file writes go through `own`, so `__proto__` or `constructor` in a file is
// only a name.
const LABELS: Record<string, string> = {
  a: 'anchor (px)',
  p: 'position (px)',
  px: 'position x (px)',
  py: 'position y (px)',
  pz: 'position z (px)',
  s: 'scale (%)',
  r: 'rotation (deg)',
  o: 'opacity (0–100)',
  sk: 'skew (deg)',
  sa: 'skew axis (deg)',
  rx: 'rotation x (deg)',
  ry: 'rotation y (deg)',
  rz: 'rotation z (deg)',
  or: 'orientation (deg)',
}
const TYPES: Record<number, string> = {
  0: 'precomp',
  1: 'solid',
  2: 'image',
  3: 'null',
  4: 'shape',
  5: 'text',
  6: 'audio',
}
/** What a layer of each type draws, which is not read. A null draws nothing. */
const CONTENT: Record<number, [feature: string, field: string]> = {
  0: ['precomp', 'refId'],
  1: ['solid', 'sc'],
  2: ['image', 'refId'],
  4: ['shapes', 'shapes'],
  5: ['text', 't'],
  6: ['audio', 'refId'],
}
/** Layer fields that change the picture and are not read. */
const LAYER_FIELDS: [field: string, feature: string][] = [
  ['masksProperties', 'masks'],
  ['ef', 'effects'],
  ['sy', 'layer styles'],
  ['tm', 'time remap'],
  ['tt', 'track matte'],
  ['td', 'track matte'],
  ['ao', 'auto-orient'],
  ['parent', 'parenting'],
  ['mb', 'motion blur'],
  ['bm', 'blend mode'],
  ['ct', 'collapse transforms'],
]
/**
 * Fields that are read, change nothing, or are what layers use (assets, fonts, chars: listed with
 * the layer that uses them). Any other field is listed by its name.
 */
const READ_TOP = new Set('v nm fr ip op w h ddd layers slots meta assets fonts chars'.split(' '))
const READ_LAYER = new Set([
  ...'ty nm mn cl ln ind ip op st sr ddd hd ks hasMask'.split(' '),
  ...LAYER_FIELDS.map(([field]) => field),
])
/** A layer's content fields beside the one listed: a precomp's size, a solid's. */
const CONTENT_FIELDS: Record<number, string[]> = { 0: ['w', 'h'], 1: ['sw', 'sh'] }

const own = <T>(table: Record<string | number, T>, key: string | number): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const fail = (where: string, what: string): never => {
  throw new Error(`motion-lottie-read: ${where} ${what}`)
}
const num = (v: unknown, where: string): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : fail(where, `is ${JSON.stringify(v)}, not a number`)
/** A value as numbers: a number is one dimension. */
const vec = (v: unknown, where: string): number[] =>
  Array.isArray(v) ? v.map((x, i) => num(x, `${where}[${i}]`)) : [num(v, where)]
const handle = (v: unknown, where: string): LottieHandle | undefined => {
  if (v === undefined) return undefined
  if (!isObj(v)) return fail(where, 'is not an {x, y} handle')
  const h = { x: vec(v.x, `${where}.x`), y: vec(v.y, `${where}.y`) }
  if (h.x.length === 0 || h.y.length === 0) fail(where, 'has an empty handle')
  for (const x of h.x) if (x < 0 || x > 1) fail(`${where}.x`, `is ${x}: a handle's x is 0 to 1`)
  return h
}

const readKeys = (k: unknown[], fr: number, where: string): LottieKey[] => {
  const keys = k.map((raw, i): LottieKey => {
    const at = `${where}.k[${i}]`
    if (!isObj(raw)) return fail(at, 'is not a keyframe')
    const frame = num(raw.t, `${at}.t`)
    const key: LottieKey = { frame, t: frame / fr, hold: raw.h === 1 || raw.h === true }
    if (raw.s !== undefined) key.value = vec(raw.s, `${at}.s`)
    if (raw.e !== undefined) key.end = vec(raw.e, `${at}.e`)
    const out = handle(raw.o, `${at}.o`)
    const inn = handle(raw.i, `${at}.i`)
    if (out) key.out = out
    if (inn) key.in = inn
    if (raw.to !== undefined) key.pathOut = vec(raw.to, `${at}.to`)
    if (raw.ti !== undefined) key.pathIn = vec(raw.ti, `${at}.ti`)
    return key
  })
  if (keys.length === 0) fail(`${where}.k`, 'is animated with no keyframes')
  const dims = (keys[0] as LottieKey).value?.length
  keys.forEach((key, i) => {
    const at = `${where}.k[${i}]`
    const prev = keys[i - 1]
    for (const [field, v] of [
      ['s', key.value],
      ['e', key.end],
    ] as const)
      if (v && dims !== undefined && v.length !== dims)
        fail(`${at}.${field}`, `has ${v.length} values, not ${dims} as the first key has`)
    if (prev && key.frame < prev.frame) fail(`${at}.t`, `is ${key.frame}, before the key before it`)
    const last = i === keys.length - 1
    if (!key.value && !(last && prev?.end)) fail(at, 'has no value (s)')
    if (!last && !key.hold && (!key.out || !key.in))
      fail(at, 'moves to the next key with no easing handles (i and o)')
  })
  return keys
}

const readProperty = (
  v: unknown,
  name: string,
  where: string,
  fr: number,
  unsupported: LottieUnsupported[],
): LottieProperty => {
  if (!isObj(v)) return fail(where, 'is not a property ({a, k})')
  const k = v.k
  const animated = v.a === 1 || (Array.isArray(k) && isObj(k[0]))
  const keys = animated ? readKeys(Array.isArray(k) ? k : [], fr, where) : []
  const value = animated ? ((keys[0] as LottieKey).value ?? []) : vec(k, `${where}.k`)
  const p: LottieProperty = {
    path: where,
    name,
    label: own(LABELS, name) ?? name,
    animated,
    value,
    keys,
  }
  if (typeof v.x === 'string') {
    p.expression = v.x
    unsupported.push({ feature: 'expression', where: `${where}.x` })
  }
  // A player turns an orientation as a quaternion, not each angle on its own curve.
  if (name === 'or' && animated) unsupported.push({ feature: '3D orientation', where })
  if (typeof v.sid === 'string') unsupported.push({ feature: 'slot', where: `${where}.sid` })
  return p
}

const readTransform = (
  ks: unknown,
  where: string,
  fr: number,
  unsupported: LottieUnsupported[],
): Record<string, LottieProperty> => {
  const out: Record<string, LottieProperty> = Object.create(null)
  if (ks === undefined) return out
  if (!isObj(ks)) return fail(where, 'is not a transform')
  for (const [name, v] of Object.entries(ks)) {
    if (name === 'p' && isObj(v) && (v.s === true || v.s === 1)) {
      for (const axis of ['x', 'y', 'z'])
        if (v[axis] !== undefined)
          out[`p${axis}`] = readProperty(v[axis], `p${axis}`, `${where}.p.${axis}`, fr, unsupported)
    } else if (isObj(v) && !('k' in v))
      unsupported.push({ feature: name, where: `${where}.${name}` })
    else out[name] = readProperty(v, name, `${where}.${name}`, fr, unsupported)
  }
  return out
}

/**
 * Reads a Lottie file: the JSON text or the parsed object. Refuses a file that is not Lottie, a
 * dotLottie archive (unzip it and pass its animations/*.json), and keys it cannot play as written.
 */
export const readLottie = (json: string | object): Lottie => {
  let doc: unknown = json
  if (typeof json === 'string') {
    // A byte order mark, as some editors save, is not part of the JSON.
    const text = json.startsWith('\uFEFF') ? json.slice(1) : json
    if (text.startsWith('PK'))
      fail('the file', 'is a dotLottie (.lottie) archive: unzip it and read animations/<name>.json')
    try {
      doc = JSON.parse(text)
    } catch (e) {
      fail('the file', `is not JSON (${(e as Error).message})`)
    }
  }
  if (!isObj(doc) || !Array.isArray(doc.layers))
    return fail('the file', 'is not a Lottie animation (no layers)')
  const fr = num(doc.fr, 'fr')
  if (fr <= 0) fail('fr', `is ${fr}: frames a second must be above 0`)
  const ip = num(doc.ip, 'ip')
  const op = num(doc.op, 'op')
  if (op <= ip) fail('op', `is ${op}, not after ip ${ip}`)
  const unsupported: LottieUnsupported[] = []
  const layers = doc.layers.map((raw, index): LottieLayer => {
    const where = `layers[${index}]`
    if (!isObj(raw)) return fail(where, 'is not a layer')
    const ty = num(raw.ty, `${where}.ty`)
    const content = own(CONTENT, ty)
    if (content) unsupported.push({ feature: content[0], where: `${where}.${content[1]}` })
    else if (!own(TYPES, ty))
      unsupported.push({ feature: `layer type ${ty}`, where: `${where}.ty` })
    for (const [field, feature] of LAYER_FIELDS) {
      const v = raw[field]
      const off =
        field !== 'parent' && (v === 0 || v === false || (Array.isArray(v) && v.length === 0))
      if (v === undefined || off) continue
      unsupported.push({ feature, where: `${where}.${field}` })
    }
    const drawn = content ? [content[1], ...(own(CONTENT_FIELDS, ty) ?? [])] : []
    for (const field of Object.keys(raw))
      if (!READ_LAYER.has(field) && !drawn.includes(field))
        unsupported.push({ feature: field, where: `${where}.${field}` })
    const lip = num(raw.ip ?? ip, `${where}.ip`)
    const lop = num(raw.op ?? op, `${where}.op`)
    if (lop <= lip) fail(`${where}.op`, `is ${lop}, not after ip ${lip}`)
    const layer: LottieLayer = {
      index,
      name: typeof raw.nm === 'string' ? raw.nm : `layer-${index}`,
      ty,
      type: own(TYPES, ty) ?? `type ${ty}`,
      ip: lip,
      op: lop,
      in: lip / fr,
      out: lop / fr,
      st: num(raw.st ?? 0, `${where}.st`),
      sr: num(raw.sr ?? 1, `${where}.sr`),
      threeD: raw.ddd === 1,
      hidden: raw.hd === true,
      transform: readTransform(raw.ks, `${where}.ks`, fr, unsupported),
    }
    if (typeof raw.ind === 'number') layer.ind = raw.ind
    if (typeof raw.parent === 'number') layer.parent = raw.parent
    return layer
  })
  if (isObj(doc.slots) || Array.isArray(doc.slots))
    unsupported.push({ feature: 'slots', where: 'slots' })
  // `markers` (the file's named segments) and any field this reader does not know.
  for (const field of Object.keys(doc))
    if (!READ_TOP.has(field)) unsupported.push({ feature: field, where: field })
  const lottie: Lottie = {
    fr,
    ip,
    op,
    in: ip / fr,
    out: op / fr,
    width: num(doc.w, 'w'),
    height: num(doc.h, 'h'),
    threeD: doc.ddd === 1,
    layers,
    unsupported,
  }
  if (typeof doc.v === 'string') lottie.version = doc.v
  if (typeof doc.nm === 'string') lottie.name = doc.nm
  return lottie
}

/** Reads a Lottie file of the project: `await loadLottie(host, 'assets/intro.json')`. */
export const loadLottie = async (
  host: { io: { read(path: string): Promise<Uint8Array> } },
  path: string,
) => readLottie(new TextDecoder().decode(await host.io.read(path)))

/** A handle's x and y for one dimension: its own, else the first. */
const pick = (h: LottieHandle, d: number) => [
  h.x[d] ?? (h.x[0] as number),
  h.y[d] ?? (h.y[0] as number),
]
/** The ease of the move from `key` to the next, for dimension d, motion-eases' bezier solve. */
const easeOf = (key: LottieKey, d: number): Ease => {
  if (key.hold) return hold
  const [x1, y1] = pick(key.out as LottieHandle, d) as [number, number]
  const [x2, y2] = pick(key.in as LottieHandle, d) as [number, number]
  return bezier(x1, y1, x2, y2)
}
/** The value a move from key i ends on: the next key's `s`, else this key's `e`. */
const endOf = (keys: readonly LottieKey[], i: number) =>
  (keys[i + 1]?.value ?? keys[i]?.end ?? keys[i]?.value) as number[]

const zero = (v?: number[]) => !v || v.every((x) => x === 0)
/** A spatial move: the key has path tangents, zero or not. A player then eases it with one curve. */
const spatial = (key: LottieKey) => key.pathOut !== undefined || key.pathIn !== undefined
/** A curved path: tangents that are not zero. */
const curved = (key: LottieKey) => !zero(key.pathOut) || !zero(key.pathIn)
/** An orientation is turned as a quaternion by a player, so it is not played here. */
const orientation = (property: LottieProperty) => {
  if (property.name === 'or' && property.keys.length > 0)
    fail(
      property.path,
      'is an animated 3D orientation, which a player turns as a quaternion: not played here',
    )
}

// The spatial path of a move: a cubic from p0 through p0 + to and p3 + ti to p3, travelled by
// arc length, so the ease sets how far along the path it is. Lengths by Gauss-Legendre.
const GL = [
  [-0.906179845938664, 0.236926885056189],
  [-0.538469310105683, 0.478628670499366],
  [0, 0.568888888888889],
  [0.538469310105683, 0.478628670499366],
  [0.906179845938664, 0.236926885056189],
] as const
const cubic = (a: number, b: number, c: number, d: number, s: number) =>
  (1 - s) ** 3 * a + 3 * (1 - s) ** 2 * s * b + 3 * (1 - s) * s * s * c + s ** 3 * d
const pathOf = (p0: number[], p3: number[], to: number[], ti: number[]) => {
  const n = Math.min(p0.length, p3.length)
  const ctrl = Array.from({ length: n }, (_, d) => {
    const a = p0[d] as number
    const b = p3[d] as number
    return [a, a + (to[d] ?? 0), b + (ti[d] ?? 0), b] as const
  })
  const speed = (s: number) =>
    Math.hypot(
      ...ctrl.map(
        ([a, b, c, d]) =>
          3 * ((1 - s) ** 2 * (b - a) + 2 * (1 - s) * s * (c - b) + s * s * (d - c)),
      ),
    )
  /** The length from 0 to s, over 64 pieces of five points each. */
  const length = (s: number) => {
    let sum = 0
    const pieces = 64
    for (let j = 0; j < pieces; j++) {
      const a = (s * j) / pieces
      const h = s / pieces / 2
      for (const [x, w] of GL) sum += w * h * speed(a + h + h * x)
    }
    return sum
  }
  const total = length(1)
  return (u: number): number[] => {
    const want = Math.min(1, Math.max(0, u)) * total
    let lo = 0
    let hi = 1
    let s = Math.min(1, Math.max(0, u))
    for (let i = 0; i < 60; i++) {
      const err = length(s) - want
      if (Math.abs(err) <= 1e-12 * Math.max(1, total)) break
      if (err < 0) lo = s
      else hi = s
      const v = speed(s)
      const next = v > 1e-12 ? s - err / v : (lo + hi) / 2
      s = next > lo && next < hi ? next : (lo + hi) / 2
    }
    return ctrl.map(([a, b, c, d]) => cubic(a, b, c, d, s))
  }
}
const paths = new WeakMap<LottieKey, (u: number) => number[]>()

/**
 * A property's value at t seconds of the file (frame t × fr), with the file's own curves. Before
 * the first key it is the first key's value; after the last, the last value; a hold keeps the key's
 * value until the next key. A move with path tangents (`to`, `ti`), zero or not, is eased by its
 * first dimension's handles, as a player does; when they are not zero it follows its curve by arc
 * length and stops at the ends of the path when the ease overshoots. Refuses an animated 3D
 * orientation (`or`), and a t that is not a number.
 */
export const valueAt = (property: LottieProperty, t: number): number[] => {
  if (!Number.isFinite(t)) fail('valueAt: t', `is ${t}, not a number of seconds`)
  orientation(property)
  const keys = property.keys
  if (keys.length === 0) return [...property.value]
  const first = keys[0] as LottieKey
  if (t <= first.t) return [...(first.value ?? [])]
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as LottieKey
    const next = keys[i + 1] as LottieKey
    if (t >= next.t) continue
    const from = key.value as number[]
    if (key.hold || next.t <= key.t) return [...from]
    const to = endOf(keys, i)
    const u = (t - key.t) / (next.t - key.t)
    if (curved(key)) {
      let path = paths.get(key)
      if (!path) {
        path = pathOf(from, to, key.pathOut ?? [], key.pathIn ?? [])
        paths.set(key, path)
      }
      return path(easeOf(key, 0)(u))
    }
    const one = spatial(key) ? easeOf(key, 0)(u) : undefined
    return from.map((v, d) => v + ((to[d] ?? v) - v) * (one ?? easeOf(key, d)(u)))
  }
  const last = keys[keys.length - 1] as LottieKey
  return [...(last.value ?? keys[keys.length - 2]?.end ?? [])]
}

/**
 * One dimension of a property as motion-keyframes' keys, `[t, value, ease]`, for `track()`: each
 * key carries the ease of the move into it. Only for a film that asks for a track; `valueAt` is the
 * file as written. Refuses a move along a curved path (`to`, `ti`), which no one-axis track is.
 */
export const keysOf = (property: LottieProperty, dimension: number): [number, number, Ease][] => {
  // No default: which dimension becomes the track is the film's choice.
  if (!Number.isInteger(dimension) || dimension < 0)
    fail(property.path, `needs keysOf's dimension, 0 for x, 1 for y…, not ${dimension}`)
  orientation(property)
  const keys = property.keys
  const at = (v: number[] | undefined, where: string) =>
    v?.[dimension] ?? fail(where, `has no dimension ${dimension}`)
  if (keys.length === 0) return [[0, at(property.value, property.path), linear]]
  return keys.map((key, i) => {
    const prev = keys[i - 1]
    if (prev && curved(prev))
      fail(`${property.path}.k[${i - 1}]`, 'moves along a curved path (to, ti): use valueAt')
    const value = key.value ?? (prev?.end as number[])
    const ease = prev ? easeOf(prev, spatial(prev) ? 0 : dimension) : linear
    return [key.t, at(value, `${property.path}.k[${i}]`), ease]
  })
}
