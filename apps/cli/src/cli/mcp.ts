import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { diffJson, diffPixels, type Json, type Matrices, sha256 } from '@shaderera/core'
import { describeCamera } from '../camera/describe.ts'
import { shadereraVersion } from '../deliver/environment.ts'
import { encodePng } from '../deliver/png.ts'
import { refuseSoftware } from '../node/adapter.ts'
import type { Child } from '../node/child.ts'
import { inside } from '../node/inside.ts'
import { findProject } from '../node/project.ts'
import { createNodeSession, type NodeSession } from '../node/session.ts'
import { diffRevisions } from '../project/diff.ts'
import {
  createJob,
  listJobs,
  openJob,
  readJob,
  safeName,
  videoOptionsOf,
  windowOf,
} from '../project/jobs.ts'
import { outputRequirements, readRequirements } from '../project/requirements.ts'
import { head, log, releaseFrozen, restore, save, slash, undo } from '../project/revisions.ts'
import { contactSheet, type ReviewReport, review, toPng } from '../review/review.ts'
import { track } from '../review/timing.ts'
import { type VariantFrames, variantSheet } from '../review/variant-sheet.ts'
import { insideFilm, open, parse } from './args.ts'
import { checkChild } from './check.ts'
import { crop, objectRegion, parseRegion, type Region } from './crop.ts'
import { valueAt } from './inspect.ts'
import { exportVideo, extensionOf } from './render.ts'
import { stillTimes } from './still.ts'
import { nameOf, sameAsMain, variantList } from './variants.ts'

type Obj = { [k: string]: Json }
type Found = { path: string; value: Obj }

/** Every object in the JSON with its key path. */
const objects = (json: Json, path = '', out: Found[] = []): Found[] => {
  if (json === null || typeof json !== 'object') return out
  if (!Array.isArray(json)) out.push({ path, value: json as Obj })
  for (const [k, v] of Object.entries(json)) objects(v as Json, path ? `${path}.${k}` : k, out)
  return out
}

const byId = (json: Json, id: string) => objects(json).find((o) => o.value.id === id)

/** The file, line, column and the ±8 numbered lines around a `file:line:col` stamp. */
const sourceAt = (root: string, source: string) => {
  const [, file, line, column] = /^(.*):(\d+):(\d+)$/.exec(source) ?? []
  if (!file) throw new Error(`Not a file:line:col source: ${source}`)
  const path = inside(root, file)
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const n = Number(line)
  const from = Math.max(1, n - 8)
  const around = lines.slice(from - 1, n + 8).map((l, i) => `${from + i}: ${l}`)
  return { file: path, line: n, column: Number(column), around: around.join('\n') }
}

/** Numbers about one frame: hash, mean RGBA and the bounding box of pixels with alpha > 0. */
const frameStats = async (px: Uint8Array, width: number) => {
  const sum = [0, 0, 0, 0]
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1]
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + (px[i + c] as number)
    if (px[i + 3]) {
      const x = (i / 4) % width
      const y = Math.floor(i / 4 / width)
      ;[x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]
    }
  }
  const n = px.length / 4
  return {
    sha256: await sha256(px),
    meanRgba: sum.map((s) => Number((s / n).toFixed(3))),
    alphaBox: x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
  }
}

/** A value as a message shows it: a string quoted, as the client sent it. */
const shown = (x: unknown) => (typeof x === 'string' ? JSON.stringify(x) : String(x))

/**
 * The time `key` of a call (`fallback` when it is not given), in seconds inside the film, as the
 * CLI checks its times (insideFilm); throws naming it when it is missing, not a number or outside.
 */
const timeOf = (
  // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
  a: { [k: string]: any },
  key: string,
  o: { tool: string; duration: number; fallback?: number },
): number => {
  const t = a[key] ?? o.fallback
  if (t === undefined) throw new Error(`${o.tool} needs ${key} (seconds).`)
  if (typeof t !== 'number' || !Number.isFinite(t))
    throw new Error(`Not a time in seconds: ${key} ${shown(t)}.`)
  insideFilm([t], o.duration)
  return t
}

/** still's `times`: numbers of seconds (stillTimes then checks each is inside the film). */
const timesOf = (times: unknown): number[] => {
  if (times === undefined) return []
  if (!Array.isArray(times)) throw new Error('times is a list of seconds.')
  const bad = times.filter((t) => typeof t !== 'number' || !Number.isFinite(t))
  if (bad.length > 0) throw new Error(`Not a time in seconds: ${bad.map(shown).join(', ')}.`)
  return times
}

/** An image content block of a base64 PNG. */
const image = (data: string) => ({ type: 'image', data, mimeType: 'image/png' })

/** A revision as a tool returns it: the count of its files, not each one's hash. */
const briefRevision = <R extends { files: object }>({ files, ...r }: R) => ({
  ...r,
  files: Object.keys(files).length,
})

/** A review report as a tool returns it: its files relative to the project, with `/`. */
const relativeReport = <R extends ReviewReport>(root: string, r: R): R => {
  const rel = (p: string) => slash(relative(root, p))
  return {
    ...r,
    contactSheet: rel(r.contactSheet),
    frames: r.frames.map((f) => ({ ...f, file: rel(f.file), thumb: rel(f.thumb) })),
  }
}

/** The long side of render_frame's image unless `full`: a full HD PNG is ~3 MB of base64. */
const IMAGE = 1024
/** The most frames one `still` sheet holds. */
const SHEET = 64
/** The tools that take `variant` and `params`, and the ones that return content blocks. */
const LOOKS = new Set(['render_frame', 'still', 'inspect', 'compare'])
const IMAGES = new Set(['render_frame', 'still', 'review'])

/** MCP `params` as `--param key=value` flags (`open` parses each value as JSON). */
const paramFlags = (params: Obj | undefined) =>
  Object.entries(params ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`)

/** A frame's straight RGBA as a PNG, byte for byte (a canvas would premultiply on the way). */
const png = (px: Uint8Array, width: number, height: number): string =>
  Buffer.from(encodePng(px, width, height)).toString('base64')

const num = { type: 'number' }
const str = { type: 'string' }
const obj = { type: 'object' }
/** `variant` and `params`: the call renders that variant of shaderera.json, these params over it. */
const looks = { variant: str, params: obj }
/** `variants`: several outputs in one call, each in its own host, at once. */
const several = { variants: { oneOf: [{ type: 'array', items: str }, { const: 'all' }] } }
const SEVERAL =
  'variants (a list of names, main for the manifest\'s own output, or "all": main and every variant, main left out (and named as main) when a variant renders the same) runs each in its own host at once, instead of variant.'

const tools: [string, string, { [k: string]: object }, string[]][] = [
  [
    'render_frame',
    'Renders t; returns sha256, mean RGBA, alpha bounding box, layers and ms (a PNG only with image: true, at most 1024 px on its long side unless full: true). camera ({view, projection}) applies to this frame only. region ([x, y, width, height] in frame pixels) or object (an inspected id with a bbox, or a text run with its box) makes the image that part of the frame, enlarged scale times (whole pixels, 1–16) for a close look. variant (from shaderera.json) and params (over its defaults) render that version.',
    {
      t: num,
      final: { type: 'boolean' },
      camera: obj,
      image: { type: 'boolean' },
      full: { type: 'boolean' },
      region: { type: 'array', items: num },
      object: str,
      scale: num,
      ...looks,
    },
    ['t'],
  ],
  [
    'still',
    `Like \`shaderera still <t>... --sheet\`: renders each of times (seconds), or every \`every\` seconds from 0, and returns one contact sheet image, each frame labelled with its t. variant and params as render_frame. With variants, one sheet of them side by side: a row per t, each variant at the same height, labelled with its name, t and size, the safe area requirements.json declares dashed. ${SEVERAL}`,
    { times: { type: 'array', items: num }, every: num, ...looks, ...several },
    [],
  ],
  [
    'inspect',
    "Returns the source's inspect JSON at t, or the subtree at a diffJson path (a.b, a[id=x]). With track (a path) instead of t, like `shaderera inspect --track`: the value at that path at every frame from from to to (default the whole film), each { t, value, speed? } (speed per second, for numbers and arrays of numbers): a curve to read easing, holds and overshoot. variant and params as render_frame.",
    { t: num, path: str, track: str, from: num, to: num, ...looks },
    [],
  ],
  [
    'compare',
    'Compares two times: returns diffJson of inspect(a) vs inspect(b) (under path) and diffPixels of the final frames. variant and params as render_frame. (`shaderera diff` compares two revisions.)',
    { a: num, b: num, path: str, ...looks },
    ['a', 'b'],
  ],
  [
    'pick',
    'Returns the Pick at pixel (x, y) at t, the inspected object with that id and its source.',
    { t: num, x: num, y: num },
    ['t', 'x', 'y'],
  ],
  [
    'get_camera',
    'Returns the camera matrices at t, the camera in words (eye, forward, up, fovY, near, far) and the source of the inspect camera object.',
    { t: num },
    ['t'],
  ],
  [
    'get_source',
    'Returns the file, line, column and ±8 numbered lines of the source of the inspect object with this id.',
    { id: str, t: num },
    ['id'],
  ],
  [
    'check',
    `Like \`shaderera check\`: renders times sampled t (default 20, where the CLI's check takes 50) twice in two orders; returns failures and preview vs final. hdr10: true checks the hdr10 render of a film with hdr10 in shaderera.json (its P010, the peak and the layers’ light) and returns its light levels. With variants, { variants: [{ variant, ...result }] }. ${SEVERAL}`,
    { times: num, seed: num, hdr10: { type: 'boolean' }, ...several },
    [],
  ],
  [
    'render',
    'Like `shaderera render`: writes an mp4 (out: inside the project) with ffmpeg, refusing a source that is not deterministic; returns the file, frame count and seconds. With job (a name from the job tool), renders that frozen job instead of the working tree. hdr10: true makes an HDR10 mp4 (HEVC Main 10) of a film with hdr10 in shaderera.json, and returns its measured light levels; a job asks for it when it is made. A host on a software GPU (SwiftShader, llvmpipe, WARP: 10–100× slower) is refused unless softwareGpu: true.',
    {
      from: num,
      to: num,
      out: str,
      job: str,
      hdr10: { type: 'boolean' },
      softwareGpu: { type: 'boolean' },
    },
    [],
  ],
  [
    'save',
    'Like `shaderera save`: saves the project as a revision (versions/); returns its id. The same files always have the same id.',
    { label: str, note: str },
    [],
  ],
  [
    'versions',
    'Like `shaderera versions`: returns the head revision, the log of saves, restores and undos, and the render jobs.',
    {},
    [],
  ],
  [
    'restore',
    'Like `shaderera restore <id>`: makes the project that revision (the working tree is saved first); returns the revision now checked out.',
    { id: str },
    ['id'],
  ],
  [
    'undo',
    'Like `shaderera undo`: returns the project to the previous revision (unsaved edits are saved first); returns the revision now checked out.',
    {},
    [],
  ],
  [
    'diff',
    'Like `shaderera diff <a> [<b>]`: the files added, removed and changed from revision a to b (or to the working tree), and a unified patch of their text unless stat: true.',
    { a: str, b: str, stat: { type: 'boolean' } },
    ['a'],
  ],
  [
    'job',
    'Like `shaderera job`: freezes a render job: a revision (the project is saved first unless revision is given), a variant from shaderera.json, params over the defaults, an optional window. hdr10: true makes a job that renders an HDR10 mp4 (shaderera.json needs hdr10). Returns the job.',
    {
      variant: str,
      params: obj,
      revision: str,
      name: str,
      label: str,
      from: num,
      to: num,
      hdr10: { type: 'boolean' },
    },
    [],
  ],
  [
    'review',
    `Like \`shaderera review\`: renders the shots (or 7 evenly spaced frames), transition samples and the last frame, writes a contact sheet to out/review/ and runs the technical checks (format, determinism, blank frames, end hold, text fit and overlap, glyphs, copy, assets, readback, alpha) against requirements.json; returns the report JSON plus the contact sheet and frame thumbs as images. quick skips determinism and readback. With variants, { variants: [{ variant, ...report }] } and each one's contact sheet, each in out/review/<variant>/ (main in out/review/). ${SEVERAL}`,
    { variant: str, quick: { type: 'boolean' }, ...several },
    [],
  ],
]

/**
 * The project of a call: its `root` (resolved against `dir`), or else `dir` itself, and every
 * folder above it. With none, the error says how to start one.
 */
const projectOf = async (dir: string, root: unknown) => {
  const from = typeof root === 'string' ? resolve(dir, root) : dir
  try {
    return await findProject(from)
  } catch (e) {
    if (!/^No shaderera\.json/.test((e as Error).message)) throw e
    throw new Error(
      `No Shaderera project (shaderera.json) in ${from} or above it. Pass root: the project's folder, or start a project: npx create-shaderera@latest my-film, then npm install in it.`,
    )
  }
}

/**
 * An MCP server whose tools are the CLI's operations on a project's child, reopened (with the
 * project read again) when files change. It starts anywhere: each call finds its project from its
 * `root`, or from `dir` (the server's folder) and above, so one server serves several projects,
 * one session each. Tool calls run one at a time, whole, so one call's camera override never
 * reaches another call's render.
 */
export const createServer = (
  dir: string,
  flags: { trusted?: boolean; timeout?: string; variant?: string; host?: string } = {},
) => {
  const sessions = new Map<string, NodeSession>()
  const sessionOf = (root: string) => {
    let session = sessions.get(root)
    if (!session) {
      session = createNodeSession(root, flags)
      sessions.set(root, session)
    }
    return session
  }
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run, run)
    queue = result.catch(() => {})
    return result
  }
  const final = async (c: Child, t: number) => (await c.render(t, 'final')).pixels
  const inspect = async (c: Child, t: number) => {
    if (!c.has.inspect) throw new Error('This source has no inspect(t).')
    return c.inspect(t)
  }
  /**
   * still, check and review for several variants: each opens its own host, with the call's
   * params, and they run at once; every host is closed with the call.
   */
  const forVariants = async (
    root: string,
    name: string,
    // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
    a: { [k: string]: any },
    params: Obj | undefined,
  ): Promise<unknown> => {
    if (typeof a.variant === 'string') throw new Error('Give variant or variants, not both.')
    const { manifest } = await findProject(root)
    const names = variantList(a.variants, manifest)
    /** `all` left main out for the variant that renders the same. */
    const same = a.variants === 'all' ? sameAsMain(manifest) : undefined
    const main = same ? { main: same } : {}
    const opening = await Promise.allSettled(
      names.map((variant) =>
        open({
          ...flags,
          root,
          variant,
          param: paramFlags(params),
          ...(name === 'check' && a.hdr10 === true ? { hdr10: true } : {}),
        }),
      ),
    )
    const hosts = opening.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []))
    try {
      const failed = opening.find((o) => o.status === 'rejected')
      if (failed) throw (failed as PromiseRejectedResult).reason
      const each = <T>(
        run: (o: (typeof hosts)[number], variant: string | undefined) => Promise<T>,
      ) => Promise.all(hosts.map((o, i) => run(o, names[i])))
      if (name === 'check') {
        const results = await each((o) =>
          checkChild(o.child, o.project.manifest, { times: a.times ?? 20, seed: a.seed }),
        )
        return { ...main, variants: results.map((r, i) => ({ variant: nameOf(names[i]), ...r })) }
      }
      const required = readRequirements(root)
      if (name === 'still') {
        const given = timesOf(a.times)
        const every = typeof a.every === 'number' ? a.every : undefined
        if (given.length === 0 && every === undefined)
          throw new Error('still needs times or every.')
        const shortest = Math.min(...hosts.map((o) => o.project.manifest.duration))
        const times = stillTimes(given, every, shortest)
        if (times.length * hosts.length > SHEET)
          throw new Error(
            `${times.length * hosts.length} frames: a sheet holds at most ${SHEET}. Give fewer times or variants, or a longer every.`,
          )
        const frames = await each(async (o, variant): Promise<VariantFrames> => {
          const { width, height } = o.project.manifest
          const { safeArea } = outputRequirements(required, { variant, ...o.project.manifest })
          const rendered = []
          for (const t of times) rendered.push({ t, pixels: await final(o.child, t) })
          return {
            name: nameOf(variant),
            width,
            height,
            ...(safeArea ? { safeArea } : {}),
            frames: rendered,
          }
        })
        const sheet = await variantSheet(frames)
        const sizes = frames.map((f) => ({ variant: f.name, width: f.width, height: f.height }))
        return [
          { type: 'text', text: JSON.stringify({ times, ...main, variants: sizes }) },
          image(sheet.toString('base64')),
        ]
      }
      const reports = await each((o, variant) =>
        review({
          project: o.project,
          child: o.child,
          outDir: join(root, 'out', 'review', ...(variant ? [safeName(variant)] : [])),
          requirements: outputRequirements(required, { variant, ...o.project.manifest }),
          quick: a.quick === true,
          reopen: async (size) =>
            (await open({ ...flags, root, variant, param: paramFlags(params) }, size)).child,
        }),
      )
      return [
        {
          type: 'text',
          text: JSON.stringify({
            ...main,
            variants: reports.map((r, i) => ({
              variant: nameOf(names[i]),
              ...relativeReport(root, r),
            })),
          }),
        },
        ...reports.map((r) => image(readFileSync(r.contactSheet).toString('base64'))),
      ]
    } finally {
      await Promise.all(hosts.map((o) => o.child.close()))
    }
  }
  /** The tools on versions/ alone: no child opens for them. */
  // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
  const revisions: { [name: string]: (root: string, a: { [k: string]: any }) => unknown } = {
    restore: (root, a) => {
      if (typeof a.id !== 'string') throw new Error('restore needs id: a revision from versions.')
      const { files, ...r } = restore(root, a.id, 'agent')
      return r
    },
    undo: (root) => {
      const { files, ...r } = undo(root, 'agent')
      return r
    },
    diff: (root, a) => {
      if (typeof a.a !== 'string') throw new Error('diff needs a: a revision from versions.')
      const d = diffRevisions(root, a.a, typeof a.b === 'string' ? a.b : undefined)
      return a.stat === true ? { added: d.added, removed: d.removed, changed: d.changed } : d
    },
  }
  // The low-level Server does not check arguments against a tool's input schema: they come as
  // the client sent them, and each tool reads what it needs.
  const call = async (
    root: string,
    session: NodeSession,
    name: string,
    // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
    a: { [k: string]: any },
  ): Promise<unknown> => {
    // A variant or params get their own child, closed with the call; the session's child is the
    // server's own variant (`--variant`), with the defaults.
    if (Array.isArray(a.params)) throw new Error('params is an object of name → value.')
    const params = a.params && typeof a.params === 'object' ? (a.params as Obj) : undefined
    if (a.variants !== undefined && ['still', 'check', 'review'].includes(name))
      return forVariants(root, name, a, params)
    const variant = typeof a.variant === 'string' ? a.variant : flags.variant
    const own =
      LOOKS.has(name) && (typeof a.variant === 'string' || params)
        ? await open({ ...flags, root, variant, param: paramFlags(params) })
        : undefined
    const opened = own ?? (await session.open())
    const { manifest } = opened.project
    const c = opened.child
    const at = (key: string, fallback?: number) =>
      timeOf(a, key, { tool: name, duration: manifest.duration, fallback })
    try {
      switch (name) {
        case 'render_frame': {
          const t = at('t')
          const start = performance.now()
          if (a.camera) await c.override(a.camera as Matrices)
          try {
            const r = await c.render(t, a.final === false ? 'preview' : 'final')
            const ms = performance.now() - start
            const stats = { ...(await frameStats(r.pixels, manifest.width)), layers: r.layers, ms }
            const text = { type: 'text', text: JSON.stringify(stats) }
            if (!a.image) return [text]
            const region: Region | undefined = Array.isArray(a.region)
              ? parseRegion(a.region.join(','))
              : typeof a.object === 'string'
                ? objectRegion(await c.inspect(t), a.object)
                : undefined
            if (!region) {
              const { width, height } = manifest
              const k = a.full === true ? 1 : Math.min(1, IMAGE / Math.max(width, height))
              const size = {
                width: Math.max(1, Math.round(width * k)),
                height: Math.max(1, Math.round(height * k)),
              }
              const data =
                k === 1
                  ? png(r.pixels, width, height)
                  : (await toPng(r.pixels, width, height, IMAGE)).toString('base64')
              return [text, { type: 'text', text: JSON.stringify(size) }, image(data)]
            }
            const part = crop(r.pixels, manifest, region, a.scale ?? 1)
            const where = {
              type: 'text',
              text: JSON.stringify({
                width: part.width,
                height: part.height,
                region: part.region,
                scale: a.scale ?? 1,
              }),
            }
            return [text, where, image(png(part.pixels, part.width, part.height))]
          } finally {
            if (a.camera) await c.override(null)
          }
        }
        case 'still': {
          const given = timesOf(a.times)
          const every = typeof a.every === 'number' ? a.every : undefined
          if (given.length === 0 && every === undefined)
            throw new Error('still needs times or every.')
          const times = stillTimes(given, every, manifest.duration)
          if (times.length > SHEET)
            throw new Error(
              `${times.length} frames: a sheet holds at most ${SHEET}. Give fewer times or a longer every.`,
            )
          const frames = []
          for (const t of times)
            frames.push({ t, label: variant ?? 'main', pixels: await final(c, t) })
          const sheet = await contactSheet(frames, manifest.width, manifest.height)
          return [
            { type: 'text', text: JSON.stringify({ times }) },
            image(sheet.toString('base64')),
          ]
        }
        case 'inspect': {
          // track reads a window, not one t: it runs before t is checked.
          if (typeof a.track === 'string') {
            const { from, to } = windowOf(manifest, a.from, a.to)
            if (!c.has.inspect) throw new Error('This source has no inspect(t).')
            const curve = await track((t) => c.inspect(t), a.track, { fps: manifest.fps, from, to })
            if (curve.every((p) => p.value === undefined))
              throw new Error(`Nothing at ${a.track} in inspect.`)
            return curve
          }
          if (a.t === undefined) throw new Error('inspect needs t, or track.')
          const json = await inspect(c, at('t'))
          const value = a.path ? valueAt(json, a.path) : json
          if (value === undefined) throw new Error(`Nothing at ${a.path} in inspect.`)
          return value
        }
        case 'compare': {
          const [ta, tb] = [at('a'), at('b')]
          const [x, y] = [await inspect(c, ta), await inspect(c, tb)]
          const under = (j: Json) => (a.path ? (valueAt(j, a.path) ?? null) : j)
          const pixels = diffPixels(await final(c, ta), await final(c, tb))
          return { changes: diffJson(under(x), under(y)), pixels }
        }
        case 'pick': {
          const t = at('t')
          const pick = await c.pick(t, a.x, a.y)
          const object = pick && c.has.inspect ? byId(await c.inspect(t), pick.id) : undefined
          return { pick, object: object?.value ?? null, source: object?.value.source ?? null }
        }
        case 'get_camera': {
          const t = at('t')
          const matrices = await c.camera(t)
          if (!matrices) throw new Error('This source has no camera.')
          const json = c.has.inspect ? await c.inspect(t) : null
          const found = objects(json).find(
            (o) => o.value.id === 'camera' || /camera$/i.test(o.path),
          )
          const source = found?.value.source ?? null
          return { matrices, description: describeCamera(matrices), path: found?.path, source }
        }
        case 'get_source': {
          const t = at('t', 0)
          const found = byId(await inspect(c, t), a.id)
          if (!found) throw new Error(`No object with id ${a.id} in inspect(${t}).`)
          if (typeof found.value.source !== 'string') throw new Error(`${a.id} has no source.`)
          return { path: found.path, ...sourceAt(root, found.value.source) }
        }
        case 'check': {
          // The hdr10 render is its own host, closed with the call.
          const hdr = a.hdr10 === true ? await open({ ...flags, root, hdr10: true }) : undefined
          try {
            return await checkChild(hdr?.child ?? c, manifest, {
              times: a.times ?? 20,
              seed: a.seed,
            })
          } finally {
            await hdr?.child.close()
          }
        }
        case 'render': {
          const out = typeof a.out === 'string' ? inside(root, a.out) : undefined
          if (typeof a.job !== 'string') {
            // Before the save and ffmpeg (exportVideo checks it too).
            windowOf(manifest, a.from, a.to)
            const hdr = a.hdr10 === true ? await open({ ...flags, root, hdr10: true }) : undefined
            try {
              const host = hdr?.child ?? c
              await refuseSoftware(host, a.softwareGpu === true, 'softwareGpu: true')
              return await exportVideo(hdr?.project ?? opened.project, host, {
                from: a.from,
                to: a.to,
                out,
                revision: save(root, { by: 'agent' }).id,
              })
            } finally {
              await hdr?.child.close()
            }
          }
          if (a.hdr10 !== undefined)
            throw new Error('A job froze its range: make a job with hdr10: true instead.')
          const job = readJob(root, a.job)
          if (job.delivery.format === 'png')
            throw new Error(
              `Job ${job.name} is a png finishing handoff: shaderera render --job ${job.name}.`,
            )
          // The job's frozen delivery, as `shaderera render --job` exports it.
          const video = videoOptionsOf(job.delivery)
          const frozen = await openJob(root, job)
          try {
            await refuseSoftware(frozen.child, a.softwareGpu === true, 'softwareGpu: true')
            return await exportVideo(frozen.project, frozen.child, {
              ...video,
              from: job.output.from,
              to: job.output.to,
              out: out ?? join(root, 'out', `${job.name}${extensionOf(video.codec)}`),
              quality: job.delivery.quality,
              revision: job.revision,
            })
          } finally {
            await frozen.child.close()
            releaseFrozen(root, job.revision)
          }
        }
        case 'save':
          return briefRevision(save(root, { by: 'agent', label: a.label, note: a.note }))
        case 'versions':
          return { head: head(root), log: log(root), jobs: listJobs(root) }
        case 'job': {
          const { hdr10, ...given } = a
          return await createJob(root, {
            by: 'agent',
            host: flags.host,
            variant: flags.variant,
            ...given,
            ...(hdr10 === true ? { range: 'hdr10' as const } : {}),
            replace: false,
          })
        }
        case 'review': {
          // A variant gets its own child; the session's child is the server's own variant.
          const mine =
            typeof a.variant === 'string' ? await open({ ...flags, root, variant }) : undefined
          const target = mine ?? opened
          try {
            const report = await review({
              project: target.project,
              child: target.child,
              outDir: join(root, 'out', 'review', ...(variant ? [safeName(variant)] : [])),
              requirements: outputRequirements(readRequirements(root), {
                variant,
                ...target.project.manifest,
              }),
              quick: a.quick === true,
              reopen: async (size) => (await open({ ...flags, root, variant }, size)).child,
              ...(target.project.manifest.hdr10
                ? { hdr: async () => (await open({ ...flags, root, variant, hdr10: true })).child }
                : {}),
            })
            const file = (path: string) => image(readFileSync(path).toString('base64'))
            return [
              { type: 'text', text: JSON.stringify(relativeReport(root, report)) },
              file(report.contactSheet),
              ...report.frames.filter((f) => f.label !== 'transition').map((f) => file(f.thumb)),
            ]
          } finally {
            await mine?.child.close()
          }
        }
      }
      throw new Error(`Unknown tool ${name}.`)
    } finally {
      await own?.child.close()
    }
  }
  const server = new Server(
    { name: 'shaderera', version: shadereraVersion() },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: { type: 'object' as const, properties: { ...properties, root: str }, required },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const a = params.arguments ?? {}
    let session: NodeSession | undefined
    try {
      const r = await serial(async () => {
        if (!tools.some(([n]) => n === params.name)) throw new Error(`Unknown tool ${params.name}.`)
        const { root } = await projectOf(dir, a.root)
        session = sessionOf(root)
        const onVersions = revisions[params.name]
        if (!onVersions) return call(root, session, params.name, a)
        // restore and undo replace files the child (and its clips' ffmpeg) may hold open, which
        // Windows refuses: close it first. The next call opens it again on the new files.
        if (params.name !== 'diff') await session.drop()
        return onVersions(root, a)
      })
      const content = IMAGES.has(params.name) ? r : [{ type: 'text', text: JSON.stringify(r) }]
      return { content }
    } catch (e) {
      if (/exited|took longer/.test(String(e))) void session?.drop()
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true }
    }
  })
  server.onclose = () => {
    for (const session of sessions.values()) session.close()
  }
  return server
}

/**
 * `shaderera mcp [--root dir] [--variant name] [--host node|browser] [--trusted]`: serves the tools over stdio until stdin closes. It
 * starts in any folder; a call finds its project (its `root`, or `--root` or the cwd and above).
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {})
  const server = createServer(resolve(typeof v.root === 'string' ? v.root : process.cwd()), {
    trusted: v.trusted === true,
    timeout: typeof v.timeout === 'string' ? v.timeout : undefined,
    variant: typeof v.variant === 'string' ? v.variant : undefined,
    host: typeof v.host === 'string' ? v.host : undefined,
  })
  await server.connect(new StdioServerTransport())
  await new Promise((done) => process.stdin.once('close', done))
  await server.close()
  return 0
}
