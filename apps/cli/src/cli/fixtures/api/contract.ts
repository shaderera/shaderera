// The films API's contract (README.md): the fixtures in this folder, and how a request or an
// answer is checked against one. The CLI's tests (cli/api-contract.test.ts) and the films app's
// (shaderera/shaderera.com, apps/web) both use this file, so it imports nothing but node:fs.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A request or an answer, as a fixture writes it. */
export type Message = {
  method?: string
  /** The path under /api/v1, an example of the fixture's route. */
  path?: string
  status?: number
  /** Headers it must have (the value's shape, see headerErrors); null: it must not have it. */
  headers?: Record<string, string | null>
  /** A JSON body, an example of its shape (see shapeErrors). */
  body?: unknown
  /** A body of raw bytes, as UTF-8 text. */
  bytes?: string
  /** A body of raw bytes given by its length only. */
  size?: number
}

export type Fixture = {
  /** Its file's name, without .json. */
  name: string
  /** `METHOD /path/{param}` under /api/v1. */
  route: string
  about: string
  request: Message & { method: string; path: string }
  response: Message & { status: number }
  /** The places (`request.body.files`) that are records: their keys are data, not fields. */
  records?: string[]
  /** The places that may be absent or null. */
  optional?: string[]
}

/** Every fixture in `dir` (this folder by default), by name. */
export const loadFixtures = (dir = import.meta.dirname): Record<string, Fixture> =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        const name = f.slice(0, -'.json'.length)
        return [name, { name, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) } as Fixture]
      }),
  )

/** The route's params when `method path` is one of it (`/films/{film}` matches `/films/x1`). */
export const matchRoute = (
  route: string,
  method: string,
  path: string,
): Record<string, string> | null => {
  const [m, pattern = ''] = route.split(' ')
  if (m !== method) return null
  const names: string[] = []
  const re = pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, n: string) => {
    names.push(n)
    return '([^/]+)'
  })
  const found = new RegExp(`^${re}$`).exec(path.split('?')[0] ?? '')
  return found ? Object.fromEntries(names.map((n, i) => [n, found[i + 1] as string])) : null
}

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/**
 * Where `actual` is not shaped like the example `expected`, at `at` (`response.body`):
 * - the same JSON type; an object has every field the example has (more is allowed: v1 adds);
 * - an array's items are each shaped like the example's first item;
 * - a record (`records`) may have any keys, each value shaped like the example's first;
 * - an `optional` place may be absent or null; an example's null matches anything.
 */
export const shapeErrors = (
  expected: unknown,
  actual: unknown,
  at: string,
  o: { records?: readonly string[]; optional?: readonly string[] } = {},
): string[] => {
  if (expected === null) return []
  if (actual === undefined || actual === null)
    return o.optional?.includes(at) ? [] : [`${at}: missing`]
  if (kind(expected) !== kind(actual))
    return [`${at}: ${kind(actual)}, not ${kind(expected)} like ${JSON.stringify(expected)}`]
  if (Array.isArray(expected)) {
    if (expected.length === 0) return []
    return (actual as unknown[]).flatMap((item) => shapeErrors(expected[0], item, `${at}[]`, o))
  }
  if (kind(expected) !== 'object') return []
  const e = expected as Record<string, unknown>
  const a = actual as Record<string, unknown>
  if (o.records?.includes(at)) {
    const first = Object.values(e)[0]
    return Object.entries(a).flatMap(([k, v]) =>
      first === undefined ? [] : shapeErrors(first, v, `${at}[${JSON.stringify(k)}]`, o),
    )
  }
  return Object.keys(e).flatMap((k) => shapeErrors(e[k], a[k], `${at}.${k}`, o))
}

/**
 * Where headers `actual` (lowercase names, or a Headers) lack what `expected` asks: each named
 * one present (null: absent); a Content-Type of the same media type; a value that is a whole
 * number in the example (Retry-After) a whole number too.
 */
export const headerErrors = (
  expected: Record<string, string | null> | undefined,
  actual: Headers | Record<string, string | string[] | undefined>,
  at: string,
): string[] => {
  const get = (name: string): string | undefined => {
    if (actual instanceof Headers) return actual.get(name) ?? undefined
    const v = actual[name.toLowerCase()]
    return Array.isArray(v) ? v.join(', ') : v
  }
  const type = (v: string) => v.split(';')[0]?.trim().toLowerCase()
  return Object.entries(expected ?? {}).flatMap(([name, want]): string[] => {
    const got = get(name)
    if (want === null) return got === undefined ? [] : [`${at}.${name}: present, and must not be`]
    if (got === undefined) return [`${at}.${name}: missing`]
    if (name.toLowerCase() === 'content-type' && type(got) !== type(want))
      return [`${at}.${name}: ${got}, not ${want}`]
    if (/^\d+$/.test(want) && !/^\d+$/.test(got)) return [`${at}.${name}: ${got}, not a number`]
    return []
  })
}

/** Where an answer (its status, headers and JSON body) is not the fixture's. */
export const responseErrors = (
  f: Fixture,
  r: { status: number; headers: Headers; body?: unknown },
): string[] => [
  ...(r.status === f.response.status ? [] : [`status: ${r.status}, not ${f.response.status}`]),
  ...headerErrors(f.response.headers, r.headers, 'response.headers'),
  ...(f.response.body === undefined
    ? []
    : shapeErrors(f.response.body, r.body, 'response.body', f)),
]

/** Where a request (its method, path, headers and JSON body) is not the fixture's. */
export const requestErrors = (
  f: Fixture,
  q: {
    method: string
    path: string
    headers: Headers | Record<string, string | string[] | undefined>
    body?: unknown
  },
): string[] => [
  ...(matchRoute(f.route, q.method, q.path) ? [] : [`${q.method} ${q.path} is not ${f.route}`]),
  ...headerErrors(f.request.headers, q.headers, 'request.headers'),
  ...(f.request.body === undefined ? [] : shapeErrors(f.request.body, q.body, 'request.body', f)),
]
