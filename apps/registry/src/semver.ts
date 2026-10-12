/**
 * Version ranges for catalog requirements: the part of npm's semver a catalog needs. A range is
 * `||`-separated alternatives of space-separated comparators: `1.2.3`, `=1.2.3`, `>=1.2`, `<2`,
 * `>1`, `<=1.4`, `^1.2.3`, `~1.2.3`, `1.x`, `*`. Pre-release tags are ignored while matching
 * (`0.4.0-dev.0` satisfies `^0.4.0`): in-house builds carry them, and they must not lock a team out.
 */

type V = readonly [number, number, number]

const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** The pre-release tag of a version (`dev.1` of `0.4.0-dev.1`); empty for a release. */
const tag = (s: string) => /^v?\d+\.\d+\.\d+-([^+]+)/.exec(s.trim())?.[1] ?? ''

/**
 * Orders full versions by their numbers, then a release above its pre-releases (0.4.0 over
 * 0.4.0-dev.1), and pre-releases by their tags, numbers as numbers (dev.10 over dev.9).
 */
export const compareVersions = (a: string, b: string): number => {
  const [ta, tb] = [tag(a), tag(b)]
  return (
    cmp(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0]) ||
    (ta && tb ? ta.localeCompare(tb, 'en', { numeric: true }) : Number(!ta) - Number(!tb))
  )
}

/** A full version's numbers, without its pre-release and build tags; null when it is not one. */
export const parseVersion = (s: string): V | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(s.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** The numbers a comparator gives (`1.x` gives [1]); throws on anything else. */
const partial = (s: string): number[] => {
  const t = s.replace(/^v/, '')
  if (t === '' || /^[xX*]$/.test(t)) return []
  const nums: number[] = []
  for (const p of (t.split(/[-+]/)[0] ?? '').split('.')) {
    if (/^[xX*]$/.test(p)) break
    if (!/^\d+$/.test(p)) throw new Error(`not a version: "${s}"`)
    nums.push(Number(p))
  }
  if (nums.length > 3) throw new Error(`not a version: "${s}"`)
  return nums
}

const fill = (n: number[]): V => [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]
/** The first version past what `n` names: 1.2 → 1.3.0, 1 → 2.0.0, 1.2.3 → 1.2.4. */
const past = (n: number[]): V | null =>
  n.length === 0
    ? null
    : n.length === 1
      ? [(n[0] ?? 0) + 1, 0, 0]
      : n.length === 2
        ? [n[0] ?? 0, (n[1] ?? 0) + 1, 0]
        : [n[0] ?? 0, n[1] ?? 0, (n[2] ?? 0) + 1]

type Test = (v: V) => boolean
const within =
  (lo: V, hi: V | null): Test =>
  (v) =>
    cmp(v, lo) >= 0 && (hi === null || cmp(v, hi) < 0)

const comparator = (c: string): Test => {
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(c)
  const op = m?.[1] ?? ''
  const n = partial(m?.[2] ?? '')
  const v = fill(n)
  switch (op) {
    case '^': {
      if (n.length === 0) return () => true
      if ((n[0] ?? 0) > 0 || n.length === 1) return within(v, [(n[0] ?? 0) + 1, 0, 0])
      if ((n[1] ?? 0) > 0 || n.length === 2) return within(v, [0, (n[1] ?? 0) + 1, 0])
      return within(v, [0, 0, (n[2] ?? 0) + 1])
    }
    case '~':
      return within(v, n.length >= 2 ? [n[0] ?? 0, (n[1] ?? 0) + 1, 0] : past(n))
    case '>=':
      return (x) => cmp(x, v) >= 0
    case '>': {
      const next = n.length < 3 ? past(n) : null
      return next ? (x) => cmp(x, next) >= 0 : (x) => cmp(x, v) > 0
    }
    case '<':
      return (x) => cmp(x, v) < 0
    case '<=': {
      const next = n.length < 3 ? past(n) : null
      return next ? (x) => cmp(x, next) < 0 : (x) => cmp(x, v) <= 0
    }
    default:
      return within(v, past(n))
  }
}

const compile = (range: string): Test[][] =>
  range
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    .split('||')
    .map((alt) => alt.trim().split(/\s+/).filter(Boolean).map(comparator))

/**
 * Whether `range` is a range this module understands. Only the characters a range is made of
 * pass: a range goes on an npm command line.
 */
export const validRange = (range: string): boolean => {
  if (!/^[\w.\-^~<>=|* ]*$/.test(range)) return false
  try {
    compile(range)
    return true
  } catch {
    return false
  }
}

/** Whether `version` (a full version) satisfies `range`. */
export const satisfies = (version: string, range: string): boolean => {
  const v = parseVersion(version)
  if (!v) return false
  return compile(range).some((all) => all.every((t) => t(v)))
}
