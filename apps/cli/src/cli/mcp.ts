import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { diffJson, diffPixels, type Json, type Matrices } from '@shaderera/core'
import { sha256 } from '@shaderera/core/host'
import { describeCamera } from '../camera/describe.ts'
import { shadereraVersion } from '../deliver/environment.ts'
import { encodePng } from '../deliver/png.ts'
import type { Child } from '../node/child.ts'
import { inside } from '../node/inside.ts'
import { findProject, type Project } from '../node/project.ts'
import { createNodeSession } from '../node/session.ts'
import { createJob, listJobs, openJob, readJob, safeName, videoOptionsOf } from '../project/jobs.ts'
import { outputRequirements, readRequirements } from '../project/requirements.ts'
import { head, log, save } from '../project/revisions.ts'
import { review } from '../review/review.ts'
import { open, parse } from './args.ts'
import { checkChild } from './check.ts'
import { crop, objectRegion, parseRegion, type Region } from './crop.ts'
import { valueAt } from './inspect.ts'
import { exportVideo, extensionOf } from './render.ts'

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

/** A frame's straight RGBA as a PNG, byte for byte (a canvas would premultiply on the way). */
const png = (px: Uint8Array, width: number, height: number): string =>
  Buffer.from(encodePng(px, width, height)).toString('base64')

const num = { type: 'number' }
const str = { type: 'string' }
const tools: [string, string, { [k: string]: object }, string[]][] = [
  [
    'render_frame',
    'Renders t; returns sha256, mean RGBA, alpha bounding box, layers and ms (a PNG only with image: true). camera ({view, projection}) applies to this frame only. region ([x, y, width, height] in frame pixels) or object (an inspected id with a bbox) makes the image that part of the frame, enlarged scale times (whole pixels, 1–16) for a close look.',
    {
      t: num,
      final: { type: 'boolean' },
      camera: { type: 'object' },
      image: { type: 'boolean' },
      region: { type: 'array', items: num },
      object: str,
      scale: num,
    },
    ['t'],
  ],
  [
    'inspect',
    "Returns the source's inspect JSON at t, or the subtree at a diffJson path (a.b, a[id=x]).",
    { t: num, path: str },
    ['t'],
  ],
  [
    'diff',
    'Returns diffJson of inspect(a) vs inspect(b) (under path) and diffPixels of the final frames.',
    { a: num, b: num, path: str },
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
    'check_determinism',
    'Like `shaderera check`: renders sampled t twice in two orders; returns failures and preview vs final.',
    { times: num, seed: num },
    [],
  ],
  [
    'export',
    'Like `shaderera render`: writes an mp4 (out: inside the project) with ffmpeg, refusing a source that is not deterministic; returns the file, frame count and seconds. With job (a name from create_job), renders that frozen job instead of the working tree.',
    { from: num, to: num, out: str, job: str },
    [],
  ],
  [
    'save_revision',
    'Saves the project as a revision (versions/); returns its id. The same files always have the same id.',
    { label: str, note: str },
    [],
  ],
  [
    'list_versions',
    'Returns the head revision, the log of saves, restores and undos, and the render jobs.',
    {},
    [],
  ],
  [
    'create_job',
    'Freezes a render job: a revision (the project is saved first unless revision is given), a variant from shaderera.json, params over the defaults, an optional window. Returns the job.',
    {
      variant: str,
      params: { type: 'object' },
      revision: str,
      name: str,
      label: str,
      from: num,
      to: num,
    },
    [],
  ],
  [
    'review',
    'Like `shaderera review`: renders the shots (or 7 evenly spaced frames), transition samples and the last frame, writes a contact sheet to out/review/ and runs the technical checks (format, determinism, blank frames, end hold, text fit and overlap, glyphs, copy, assets, readback, alpha) against requirements.json; returns the report JSON plus the contact sheet and frame thumbs as images. quick skips determinism and readback.',
    { variant: str, quick: { type: 'boolean' } },
    [],
  ],
]

/**
 * An MCP server whose tools are the CLI's operations on one child, reopened (with the project read
 * again) when files change. Tool calls run one at a time, whole, so one call's camera override
 * never reaches another call's render.
 */
export const createServer = (
  project: Project,
  flags: { trusted?: boolean; timeout?: string } = {},
) => {
  const session = createNodeSession(project.root, flags)
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
  // biome-ignore lint/suspicious/noExplicitAny: arguments are checked by the tool's input schema
  const call = async (name: string, a: { [k: string]: any }): Promise<unknown> => {
    const opened = await session.open()
    const { root, manifest } = opened.project
    const c = opened.child
    switch (name) {
      case 'render_frame': {
        const start = performance.now()
        if (a.camera) await c.override(a.camera as Matrices)
        try {
          const r = await c.render(a.t, a.final === false ? 'preview' : 'final')
          const ms = performance.now() - start
          const stats = { ...(await frameStats(r.pixels, manifest.width)), layers: r.layers, ms }
          const text = { type: 'text', text: JSON.stringify(stats) }
          if (!a.image) return [text]
          const region: Region | undefined = Array.isArray(a.region)
            ? parseRegion(a.region.join(','))
            : typeof a.object === 'string'
              ? objectRegion(await c.inspect(a.t), a.object)
              : undefined
          if (!region) {
            const data = png(r.pixels, manifest.width, manifest.height)
            return [text, { type: 'image', data, mimeType: 'image/png' }]
          }
          const part = crop(r.pixels, manifest, region, a.scale ?? 1)
          const where = {
            type: 'text',
            text: JSON.stringify({ region: part.region, scale: a.scale ?? 1 }),
          }
          const data = png(part.pixels, part.width, part.height)
          return [text, where, { type: 'image', data, mimeType: 'image/png' }]
        } finally {
          if (a.camera) await c.override(null)
        }
      }
      case 'inspect': {
        const json = await inspect(c, a.t)
        const value = a.path ? valueAt(json, a.path) : json
        if (value === undefined) throw new Error(`Nothing at ${a.path} in inspect.`)
        return value
      }
      case 'diff': {
        const [x, y] = [await inspect(c, a.a), await inspect(c, a.b)]
        const under = (j: Json) => (a.path ? (valueAt(j, a.path) ?? null) : j)
        const pixels = diffPixels(await final(c, a.a), await final(c, a.b))
        return { changes: diffJson(under(x), under(y)), pixels }
      }
      case 'pick': {
        const pick = await c.pick(a.t, a.x, a.y)
        const object = pick && c.has.inspect ? byId(await c.inspect(a.t), pick.id) : undefined
        return { pick, object: object?.value ?? null, source: object?.value.source ?? null }
      }
      case 'get_camera': {
        const matrices = await c.camera(a.t)
        if (!matrices) throw new Error('This source has no camera.')
        const json = c.has.inspect ? await c.inspect(a.t) : null
        const found = objects(json).find((o) => o.value.id === 'camera' || /camera$/i.test(o.path))
        const source = found?.value.source ?? null
        return { matrices, description: describeCamera(matrices), path: found?.path, source }
      }
      case 'get_source': {
        const found = byId(await inspect(c, a.t ?? 0), a.id)
        if (!found) throw new Error(`No object with id ${a.id} in inspect(${a.t ?? 0}).`)
        if (typeof found.value.source !== 'string') throw new Error(`${a.id} has no source.`)
        return { path: found.path, ...sourceAt(root, found.value.source) }
      }
      case 'check_determinism':
        return checkChild(c, manifest, { times: a.times ?? 20, seed: a.seed })
      case 'export': {
        const out = typeof a.out === 'string' ? inside(root, a.out) : undefined
        if (typeof a.job !== 'string')
          return exportVideo(opened.project, c, {
            from: a.from,
            to: a.to,
            out,
            revision: save(root, { by: 'agent' }).id,
          })
        const job = readJob(root, a.job)
        if (job.delivery.format === 'png')
          throw new Error(
            `Job ${job.name} is a png finishing handoff: shaderera render --job ${job.name}.`,
          )
        // The job's frozen delivery, as `shaderera render --job` exports it.
        const video = videoOptionsOf(job.delivery)
        const frozen = await openJob(root, job)
        try {
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
        }
      }
      case 'save_revision':
        return save(root, { by: 'agent', label: a.label, note: a.note })
      case 'list_versions':
        return { head: head(root), log: log(root), jobs: listJobs(root) }
      case 'create_job':
        return await createJob(root, { by: 'agent', ...a, replace: false })
      case 'review': {
        // A variant gets its own child; the session's child is the main output.
        const variant = typeof a.variant === 'string' ? a.variant : undefined
        const own = variant ? await open({ root, variant, ...flags }) : undefined
        const target = own ?? opened
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
            reopen: async (size) => (await open({ root, variant, ...flags }, size)).child,
          })
          const image = (file: string) => ({
            type: 'image',
            data: readFileSync(file).toString('base64'),
            mimeType: 'image/png',
          })
          return [
            { type: 'text', text: JSON.stringify(report) },
            image(report.contactSheet),
            ...report.frames.filter((f) => f.label !== 'transition').map((f) => image(f.thumb)),
          ]
        } finally {
          await own?.child.close()
        }
      }
    }
    throw new Error(`Unknown tool ${name}.`)
  }
  const server = new Server(
    { name: 'shaderera', version: shadereraVersion() },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: { type: 'object' as const, properties, required },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const r = await serial(() => call(params.name, params.arguments ?? {}))
      const content =
        params.name === 'render_frame' || params.name === 'review'
          ? r
          : [{ type: 'text', text: JSON.stringify(r) }]
      return { content }
    } catch (e) {
      if (/exited|took longer/.test(String(e))) session.drop()
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true }
    }
  })
  server.onclose = () => session.close()
  return server
}

/** `shaderera mcp [--root dir] [--trusted]`: serves the tools over stdio until stdin closes. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {})
  const project = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const server = createServer(project, {
    trusted: v.trusted === true,
    timeout: typeof v.timeout === 'string' ? v.timeout : undefined,
  })
  await server.connect(new StdioServerTransport())
  await new Promise((done) => process.stdin.once('close', done))
  await server.close()
  return 0
}
