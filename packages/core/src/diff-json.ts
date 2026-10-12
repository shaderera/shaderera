import type { Json } from './protocol.ts'

/** One difference between two JSON values; `a` or `b` is absent when the value is missing there. */
export type JsonChange = { readonly path: string; readonly a?: Json; readonly b?: Json }

type JsonObject = { readonly [key: string]: Json }

const isObject = (v: Json): v is JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const kind = (v: Json) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

const ids = (items: readonly Json[]): Map<string, Json> | null => {
  const map = new Map<string, Json>()
  for (const item of items) {
    // A repeated id cannot pair items: they are compared by index.
    if (!isObject(item) || typeof item.id !== 'string' || map.has(item.id)) return null
    map.set(item.id, item)
  }
  return map
}

const member = (path: string, name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name)
    ? path === ''
      ? name
      : `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`

/** A structural diff of two JSON values: key order is ignored, numbers within tolerance agree. */
export const diffJson = (a: Json, b: Json, options: { tolerance?: number } = {}): JsonChange[] => {
  const tolerance = options.tolerance ?? 0
  const changes: JsonChange[] = []
  const pair = (path: string, x: Json | undefined, y: Json | undefined) => {
    if (x === undefined) changes.push({ path, b: y })
    else if (y === undefined) changes.push({ path, a: x })
    else walk(path, x, y)
  }
  const walk = (path: string, x: Json, y: Json): void => {
    if (kind(x) !== kind(y)) {
      changes.push({ path, a: x, b: y })
    } else if (typeof x === 'number' && typeof y === 'number') {
      if (!(Number.isNaN(x) && Number.isNaN(y)) && !(Math.abs(x - y) <= tolerance)) {
        changes.push({ path, a: x, b: y })
      }
    } else if (Array.isArray(x) && Array.isArray(y)) {
      const xs = x.length + y.length > 0 ? ids(x) : null
      const ys = xs ? ids(y) : null
      if (xs && ys) {
        for (const id of new Set([...xs.keys(), ...ys.keys()])) {
          pair(`${path}[id=${id}]`, xs.get(id), ys.get(id))
        }
      } else {
        for (let i = 0; i < Math.max(x.length, y.length); i++) pair(`${path}[${i}]`, x[i], y[i])
      }
    } else if (isObject(x) && isObject(y)) {
      for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
        pair(
          member(path, name),
          Object.hasOwn(x, name) ? x[name] : undefined,
          Object.hasOwn(y, name) ? y[name] : undefined,
        )
      }
    } else if (x !== y) {
      changes.push({ path, a: x, b: y })
    }
  }
  walk('', a, b)
  return changes
}
