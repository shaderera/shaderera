import type { Json } from '@shaderera/core'
import { track } from '../review/timing.ts'
import { insideFilm, open, parseRendering } from './args.ts'

const show = (v: Json): string =>
  typeof v === 'number'
    ? String(Number(v.toFixed(4)))
    : Array.isArray(v) && v.every((x) => typeof x === 'number')
      ? `[${v.map((x) => Number((x as number).toFixed(4))).join(', ')}]`
      : JSON.stringify(v)

/** A key as diffJson writes it: `.name` when it is an identifier, `["a b"]` otherwise. */
const member = (at: string, key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? (at ? `${at}.${key}` : key) : `${at}[${JSON.stringify(key)}]`

const ided = (v: readonly Json[]): boolean =>
  v.every((x) => typeof (x as { id?: unknown } | null)?.id === 'string')

const SEGMENT = /\.?([A-Za-z_$][\w$]*)|\[(\d+)\]|\[id=([^\]]+)\]|\[("(?:[^"\\]|\\.)*")\]/g

/** The value at a diffJson path: `a.b`, `a[2]`, `a[id=stand]`, `a["x y"]`. */
export const valueAt = (json: Json, path: string): Json | undefined => {
  let value: Json | undefined = json
  for (const [, name, index, id, quoted] of path.matchAll(SEGMENT)) {
    if (value === null || typeof value !== 'object') return undefined
    if (Array.isArray(value)) {
      value =
        id === undefined
          ? value[Number(index)]
          : value.find((x: Json) => (x as { id?: unknown } | null)?.id === id)
    } else value = (value as { [k: string]: Json })[name ?? JSON.parse(quoted ?? '""')]
  }
  return value
}

/** The JSON at `path` (diffJson's path syntax), one leaf per line as `path value`. */
export const formatInspect = (json: Json, path?: string): string => {
  const value = path ? valueAt(json, path) : json
  if (value === undefined) throw new Error(`Nothing at ${path} in inspect.`)
  const lines: string[] = []
  const walk = (v: Json, at: string) => {
    if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
      lines.push(`${at} [${v.map(show).join(', ')}]`)
    } else if (Array.isArray(v) && v.length > 0) {
      const keyed = ided(v)
      v.forEach((x, i) => {
        walk(x, keyed ? `${at}[id=${(x as { id: string }).id}]` : `${at}[${i}]`)
      })
    } else if (v !== null && typeof v === 'object' && Object.keys(v).length > 0) {
      for (const [k, x] of Object.entries(v)) walk(x as Json, member(at, k))
    } else {
      const text = typeof v === 'string' && /(^|\.)source$/.test(at) ? v : show(v)
      lines.push(`${at} ${text}`.trim())
    }
  }
  walk(value, path ?? '')
  return lines.join('\n')
}

/**
 * `shaderera inspect <t> [--path a.b] [--json]` (or `--time <t>`), or `inspect --track <path> [--from s]
 * [--to s] [--json]`: the value at a path at every frame, with its speed per second (numbers and
 * arrays of numbers): a curve to read easing, holds and overshoot from.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v, times } = parseRendering(
    argv,
    {
      path: { type: 'string' },
      json: { type: 'boolean' },
      track: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
    { command: 'inspect', times: true },
  )
  if (typeof v.track === 'string') {
    if (times.length > 0)
      throw new Error('inspect --track reads every frame: give --from and --to, not times.')
    const { project, child } = await open(v)
    try {
      if (!child.has.inspect) throw new Error('This source has no inspect(t).')
      const { fps, duration } = project.manifest
      const curve = await track((t) => child.inspect(t), v.track, {
        fps,
        from: v.from === undefined ? 0 : Number(v.from),
        to: v.to === undefined ? duration : Number(v.to),
      })
      if (curve.every((p) => p.value === undefined))
        throw new Error(`Nothing at ${v.track} in inspect.`)
      if (v.json) console.log(JSON.stringify(curve))
      else
        for (const p of curve)
          console.log(
            `${p.t.toFixed(3)}  ${show(p.value ?? null)}${p.speed === undefined ? '' : `  speed ${Number(p.speed.toFixed(4))}/s`}`,
          )
      return 0
    } finally {
      await child.close()
    }
  }
  const [t, ...more] = times
  if (t === undefined || more.length > 0)
    throw new Error('inspect takes one time: inspect <seconds>.')
  const { project, child } = await open(v)
  try {
    insideFilm([t], project.manifest.duration)
    if (!child.has.inspect) throw new Error('This source has no inspect(t).')
    const json = await child.inspect(t)
    const path = v.path as string | undefined
    if (!v.json) console.log(formatInspect(json, path))
    else {
      const value = path ? valueAt(json, path) : json
      if (value === undefined) throw new Error(`Nothing at ${path} in inspect.`)
      console.log(JSON.stringify(value, null, 2))
    }
    return 0
  } finally {
    await child.close()
  }
}
