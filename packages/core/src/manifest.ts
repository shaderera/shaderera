import type { Json, Manifest } from './protocol.ts'
import { parseFps } from './time.ts'

const known = new Set([
  '$schema',
  'entry',
  'dom',
  'host',
  'domScale',
  'fps',
  'duration',
  'width',
  'height',
  'params',
  'seed',
  'sequential',
  'stamp',
  'variants',
  'preroll',
  'timecode',
  'textless',
  'bakes',
  'hdr10',
])

/** Problems with `bakes`: each a command, its inputs, a folder, and frame names with `#`s. */
const bakeProblems = (bakes: unknown): string[] => {
  if (!isObject(bakes)) return ['bakes must be an object']
  const p: string[] = []
  for (const [name, b] of Object.entries(bakes)) {
    if (!/^[\w.-]+$/.test(name)) p.push(`bakes.${name}: a name is letters, digits, . _ -`)
    if (!isObject(b)) {
      p.push(`bakes.${name} must be an object`)
      continue
    }
    if (typeof b.command !== 'string' || b.command.trim() === '')
      p.push(`bakes.${name}.command must be a non-empty string`)
    if (!Array.isArray(b.inputs) || b.inputs.some((i) => typeof i !== 'string' || i === ''))
      p.push(`bakes.${name}.inputs must be a list of project paths`)
    if (typeof b.dir !== 'string' || b.dir === '') p.push(`bakes.${name}.dir must be a folder`)
    if (typeof b.frames !== 'string' || !/^[^#/\\]*#+[^#/\\]*$/.test(b.frames))
      p.push(`bakes.${name}.frames must be a file name with one run of #s, such as beauty.####.jpg`)
    for (const key of Object.keys(b))
      if (!['command', 'inputs', 'dir', 'frames'].includes(key))
        p.push(`bakes.${name}: unknown key "${key}"`)
  }
  return p
}

/** BT.2408's Graphics White, in cd/m²: where an SDR layer's white goes in an HDR10 frame. */
export const GRAPHICS_WHITE = 203
/** PQ's 1.0 (SMPTE ST 2084), in cd/m². */
const PQ_PEAK = 10000

/** Problems with `hdr10`: the mastering display and the dither are required, the rest checked. */
const hdr10Problems = (h: unknown): string[] => {
  if (!isObject(h)) return ['hdr10 must be an object']
  const p: string[] = []
  const d = h.mastering
  if (d === undefined)
    p.push(
      'hdr10.mastering is required: the display the film was graded on, { peak, min, primaries } (SMPTE ST 2086 describes one but names none; P3-D65 at 1000 cd/m² is common)',
    )
  else if (!isObject(d)) p.push('hdr10.mastering must be { peak, min, primaries }')
  else {
    if (!(positive(d.peak) && (d.peak as number) <= PQ_PEAK))
      p.push(`hdr10.mastering.peak must be in cd/m², above 0 and at most ${PQ_PEAK} (PQ's peak)`)
    const peak = positive(d.peak) ? (d.peak as number) : Infinity
    if (!(typeof d.min === 'number' && d.min >= 0 && d.min < peak))
      p.push('hdr10.mastering.min must be in cd/m², from 0 and below the peak')
    if (!['p3-d65', 'bt2020', 'bt709'].includes(d.primaries as string))
      p.push('hdr10.mastering.primaries must be "p3-d65", "bt2020" or "bt709"')
    for (const key of Object.keys(d))
      if (!['peak', 'min', 'primaries'].includes(key))
        p.push(`hdr10.mastering: unknown key "${key}"`)
  }
  if (h.dither === undefined)
    p.push('hdr10.dither is required: "tpdf" or "none" (no standard names a dither for 10-bit PQ)')
  else if (h.dither !== 'tpdf' && h.dither !== 'none')
    p.push('hdr10.dither must be "tpdf" or "none"')
  if (h.graphicsWhite !== undefined && !positive(h.graphicsWhite))
    p.push(
      `hdr10.graphicsWhite must be in cd/m², above 0 (BT.2408's Graphics White is ${GRAPHICS_WHITE})`,
    )
  for (const key of Object.keys(h))
    if (!['graphicsWhite', 'mastering', 'dither'].includes(key))
      p.push(`hdr10: unknown key "${key}"`)
  return p
}

const TIMECODE = /^\d\d:[0-5]\d:[0-5]\d[:;]\d\d$/

/** Problems with the delivery fields a manifest or a variant may set, under `at`. */
const deliveryProblems = (v: Record<string, unknown>, at: string): string[] => {
  const p: string[] = []
  const pre = v.preroll
  if (pre !== undefined) {
    if (!isObject(pre) || !positive(pre.seconds))
      p.push(`${at}preroll must be { seconds, fill? } with seconds above 0`)
    else if (pre.fill !== undefined && pre.fill !== 'black' && pre.fill !== 'source')
      p.push(`${at}preroll.fill must be "black" or "source"`)
    else if (Object.keys(pre).some((k) => k !== 'seconds' && k !== 'fill'))
      p.push(`${at}preroll has only seconds and fill`)
  }
  if (v.timecode !== undefined && !(typeof v.timecode === 'string' && TIMECODE.test(v.timecode)))
    p.push(`${at}timecode must be HH:MM:SS:FF (or HH:MM:SS;FF drop-frame)`)
  if (v.textless !== undefined && v.textless !== true) p.push(`${at}textless must be true`)
  return p
}

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const variantProblems = (variants: unknown): string[] => {
  if (!isObject(variants)) return ['variants must be an object']
  return Object.entries(variants).flatMap(([name, v]) => {
    if (!isObject(v)) return [`variants.${name} must be an object`]
    const p: string[] = []
    for (const key of ['width', 'height'] as const)
      if (v[key] !== undefined && !(positive(v[key]) && Number.isInteger(v[key])))
        p.push(`variants.${name}.${key} must be a positive integer`)
    if (v.duration !== undefined && !positive(v.duration))
      p.push(`variants.${name}.duration must be a positive number`)
    if (v.fps !== undefined && !parseFps(v.fps))
      p.push(`variants.${name}.fps must be a positive number or a fraction such as "24000/1001"`)
    if (v.params !== undefined && !isObject(v.params))
      p.push(`variants.${name}.params must be an object`)
    if (v.label !== undefined && typeof v.label !== 'string')
      p.push(`variants.${name}.label must be a string`)
    p.push(...deliveryProblems(v, `variants.${name}.`))
    for (const key of Object.keys(v))
      if (
        ![
          'label',
          'width',
          'height',
          'duration',
          'fps',
          'params',
          'preroll',
          'timecode',
          'textless',
        ].includes(key)
      )
        p.push(`variants.${name}: unknown key "${key}"`)
    return p
  })
}

/**
 * The manifest a host opens the source with for one variant, and the params that variant sets.
 * Without a name (or with an unknown one, which throws) nothing changes.
 */
export const withVariant = (
  manifest: Manifest,
  name?: string,
): { manifest: Manifest; params: { readonly [key: string]: Json } } => {
  if (name === undefined) return { manifest, params: {} }
  const v = manifest.variants?.[name]
  if (!v) throw new Error(`shaderera.json has no variant "${name}"`)
  const { label: _, params = {}, ...size } = v
  return { manifest: { ...manifest, ...size }, params }
}

/** Checks a parsed shaderera.json and returns it as a Manifest, or throws listing every problem. */
export const checkManifest = (value: unknown): Manifest => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('shaderera.json: must be a JSON object')
  }
  const m = value as Record<string, unknown>
  const problems: string[] = []
  if (typeof m.entry !== 'string' || m.entry === '')
    problems.push('entry must be a non-empty string')
  if (!positive(m.duration)) problems.push('duration must be a positive number')
  if (!parseFps(m.fps))
    problems.push('fps must be a positive number or a fraction such as "24000/1001"')
  for (const key of ['width', 'height'] as const) {
    if (!positive(m[key]) || !Number.isInteger(m[key]))
      problems.push(`${key} must be a positive integer`)
  }
  const params = m.params
  if (
    params !== undefined &&
    (params === null || typeof params !== 'object' || Array.isArray(params))
  ) {
    problems.push('params must be an object')
  }
  if (m.seed !== undefined && !(typeof m.seed === 'number' && Number.isFinite(m.seed))) {
    problems.push('seed must be a finite number')
  }
  if (
    m.sequential !== undefined &&
    m.sequential !== true &&
    !(Number.isInteger(m.sequential) && (m.sequential as number) >= 1)
  )
    problems.push('sequential must be true or a whole number of frames from 1')
  if (m.stamp !== undefined && m.stamp !== true) problems.push('stamp must be true')
  if (m.dom !== undefined && (typeof m.dom !== 'string' || m.dom === ''))
    problems.push('dom must be a non-empty string')
  if (m.host !== undefined && m.host !== 'node' && m.host !== 'browser')
    problems.push('host must be "node" or "browser"')
  if (
    m.domScale !== undefined &&
    !(m.domScale === 1 || m.domScale === 2 || m.domScale === 3 || m.domScale === 4)
  )
    problems.push('domScale must be 1, 2, 3 or 4')
  if (m.domScale !== undefined && m.dom === undefined) problems.push('domScale needs dom')
  if (m.dom !== undefined && m.host !== 'browser')
    problems.push('dom needs the browser host: add "host": "browser"')
  if (m.$schema !== undefined && typeof m.$schema !== 'string')
    problems.push('$schema must be a string')
  if (m.variants !== undefined) problems.push(...variantProblems(m.variants))
  if (m.bakes !== undefined) problems.push(...bakeProblems(m.bakes))
  if (m.hdr10 !== undefined) problems.push(...hdr10Problems(m.hdr10))
  problems.push(...deliveryProblems(m, ''))
  for (const key of Object.keys(m)) if (!known.has(key)) problems.push(`unknown key "${key}"`)
  if (problems.length > 0) throw new Error(`shaderera.json: ${problems.join('; ')}`)
  // The rate as a number, exactly: 23.976 and "24000/1001" are both 24000 / 1001.
  const fps = (v: unknown) => (parseFps(v) as { fps: number }).fps
  const variants = m.variants as Record<string, Record<string, unknown>> | undefined
  const hdr10 = m.hdr10 as Record<string, unknown> | undefined
  return {
    ...m,
    fps: fps(m.fps),
    ...(hdr10 ? { hdr10: { graphicsWhite: GRAPHICS_WHITE, ...hdr10 } } : {}),
    ...(variants
      ? {
          variants: Object.fromEntries(
            Object.entries(variants).map(([k, v]) => [
              k,
              v.fps === undefined ? v : { ...v, fps: fps(v.fps) },
            ]),
          ),
        }
      : {}),
  } as Manifest
}
