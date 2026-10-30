import { readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { diffJson, diffPixels, type Json, type Matrices, sha256 } from '@shaderera/core'
import { describeCamera } from '../camera/describe.ts'
import { shadereraVersion } from '../deliver/environment.ts'
import { encodePng } from '../deliver/png.ts'
import { refuseSoftware } from '../node/adapter.ts'
import type { Child } from '../node/child.ts'
import { inside } from '../node/inside.ts'
import { findProject } from '../node/project.ts'
import { createNodeSession, type NodeSession } from '../node/session.ts'
import { NOTE, record } from '../project/activity.ts'
import { addComment, type CommentState, listing, replyTo, setState } from '../project/comments.ts'
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
import {
  briefRevision,
  head,
  log,
  releaseFrozen,
  restore,
  save,
  slash,
  undo,
} from '../project/revisions.ts'
import { contactSheet, type ReviewReport, review, toPng } from '../review/review.ts'
import { track } from '../review/timing.ts'
import { type VariantFrames, variantSheet } from '../review/variant-sheet.ts'
import { DRAFT_HEIGHT, insideFilm, open, parse } from './args.ts'
import { checkChild } from './check.ts'
import { crop, objectRegion, parseRegion, type Region } from './crop.ts'
import { errorFinding } from './findings.ts'
import { valueAt } from './inspect.ts'
import { studios } from './mcp-studio.ts'
import { exportVideo, extensionOf } from './render.ts'
import { revisionHosts } from './revision-host.ts'
import { openFile, stillTimes } from './still.ts'
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

/** render's `draft`: true for DRAFT_HEIGHT, or a height in pixels; undefined without one. */
const draftOf = (draft: unknown): number | undefined => {
  if (draft === undefined || draft === false) return undefined
  if (draft === true) return DRAFT_HEIGHT
  if (typeof draft !== 'number' || !Number.isInteger(draft) || draft < 2)
    throw new Error(`draft is true or a height in pixels, not ${shown(draft)}.`)
  return draft
}

/** An image content block of a base64 PNG. */
const image = (data: string) => ({ type: 'image', data, mimeType: 'image/png' })

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
/**
 * The longest side of any image a tool returns: the Claude API refuses a request with an image over
 * 8000 px, and shows one over 2000 px no sharper.
 */
const LONGEST = 2048

/** A PNG scaled down, when it is bigger, to LONGEST px on its long side. */
const fitted = async (png: Buffer): Promise<Buffer> => {
  // The IHDR chunk: width and height, big-endian, at bytes 16 and 20.
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
  const k = LONGEST / Math.max(width, height)
  if (k >= 1) return png
  const w = Math.max(1, Math.round(width * k))
  const h = Math.max(1, Math.round(height * k))
  const ctx = createCanvas(w, h).getContext('2d')
  ctx.drawImage(await loadImage(png), 0, 0, w, h)
  return ctx.canvas.encode('png')
}
/** The least time between two of render's progress notifications, in ms. */
const PROGRESS = 250
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

/** A property's schema with what it is for. */
const say = (schema: object, description: string) => ({ ...schema, description })
const num = { type: 'number' }
const str = { type: 'string' }
const obj = { type: 'object' }
const bool = { type: 'boolean' }
/** Seconds into the film, as every time a tool takes is. */
const at = (what = 'The time') => say(num, `${what}, in seconds from 0 up to the duration.`)
/** `variant` and `params`: the call renders that variant of shaderera.json, these params over it. */
const looks = {
  variant: say(str, 'A variant from shaderera.json to render instead of the main output.'),
  params: say(obj, "Params over the manifest's (and the variant's) defaults, name → value."),
}
const revision = say(
  str,
  'A saved revision id (from versions or a comment): renders that revision from its frozen copy, not the files as they are now.',
)
/** `variants`: several outputs in one call, each in its own host, at once. */
const several = {
  variants: say(
    { oneOf: [{ type: 'array', items: str }, { const: 'all' }] },
    'Several outputs at once, each in its own host, instead of variant: a list of names (main for the manifest\'s own output), or "all" (main and every variant; main is left out, and named as main, when a variant renders the same).',
  ),
}

/** What a client may show and assume of a tool: its title, and whether it changes anything. */
type Annotations = {
  title: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}
const looking = (title: string): Annotations => ({ title, readOnlyHint: true })
const writing = (title: string, o: Omit<Annotations, 'title'> = {}): Annotations => ({
  title,
  destructiveHint: false,
  ...o,
})

const tools: [string, string, { [k: string]: object }, string[], Annotations][] = [
  [
    'render_frame',
    'Renders one frame and returns numbers about it: sha256, mean RGBA, the alpha bounding box, its layers and ms. With image: true, also its size and a PNG of it (at most 1024 px on its long side, or 2048 with full: true), or of a part of it (region or object) enlarged for a close look.',
    {
      t: at(),
      final: say(bool, 'false renders the preview intent; default true (final).'),
      camera: say(obj, '{ view, projection } matrices for this frame only.'),
      image: say(bool, 'Return a PNG too.'),
      full: say(bool, 'The whole frame up to 2048 px on its long side instead of 1024.'),
      region: say(
        { type: 'array', items: num, minItems: 4, maxItems: 4 },
        '[x, y, width, height] in frame pixels: the image is that part of the frame.',
      ),
      object: say(
        str,
        'An inspected id with a bbox, or a text run with its box: the image is that part of the frame.',
      ),
      scale: say(
        { type: 'integer', minimum: 1, maximum: 16 },
        'How many times region or object is enlarged, by whole pixels; lowered to keep the long side at most 2048 px, and the size block then says so.',
      ),
      revision,
      ...looks,
    },
    ['t'],
    looking('Render a frame'),
  ],
  [
    'still',
    'Renders final frames (or, with file, reads those of a rendered video) and returns one contact sheet image, each frame labelled with its t: the way to look at the film. With variants, one sheet of them side by side: a row per t, each variant at the same height, labelled with its name, t and size, the safe area requirements.json declares dashed. At most 64 frames.',
    {
      times: say({ type: 'array', items: num }, 'The times to look at, in seconds.'),
      file: say(
        str,
        "A rendered video inside the project (out/x.mp4): the sheet is of its frames, as encoded, instead of the source's. Not with variant, variants, params or revision.",
      ),
      every: say(num, 'Also a frame every this many seconds from 0.'),
      revision,
      ...looks,
      ...several,
    },
    [],
    looking('Look at frames'),
  ],
  [
    'inspect',
    "Returns the source's inspect JSON at t, or the value at path. With track instead of t, that value at every frame from from to to: a curve, to read easing, holds and overshoot. Takes t or track.",
    {
      t: at(),
      path: say(str, 'A diffJson path into inspect (a.b, a[id=x]): only the value there.'),
      track: say(
        str,
        'A path to follow over time instead of t: returns [{ t, value, speed? }], speed per second for numbers and arrays of numbers.',
      ),
      from: at('With track, from'),
      to: at('With track, to'),
      ...looks,
    },
    [],
    looking('Inspect the state'),
  ],
  [
    'compare',
    'Compares two times: diffJson of inspect at a vs b (under path) and diffPixels of the two final frames. (diff compares two revisions.)',
    {
      a: at('The first time'),
      b: at('The second time'),
      path: say(str, 'Compare inspect only under this path.'),
      ...looks,
    },
    ['a', 'b'],
    looking('Compare two times'),
  ],
  [
    'pick',
    'Returns what is drawn at a pixel at t: the Pick, the inspected object with that id and its source.',
    {
      t: at(),
      x: say(num, 'Frame pixels from the left.'),
      y: say(num, 'Frame pixels from the top.'),
    },
    ['t', 'x', 'y'],
    looking('Pick a pixel'),
  ],
  [
    'get_camera',
    'Returns the camera at t: its matrices, the camera in words (eye, forward, up, fovY, near, far) and the source of the inspect camera object.',
    { t: at() },
    ['t'],
    looking('Read the camera'),
  ],
  [
    'get_source',
    'Returns the file, line, column and ±8 numbered lines of the source of an inspect object.',
    { id: say(str, 'The id of an object in inspect.'), t: at('The time to inspect (default 0)') },
    ['id'],
    looking('Find the source'),
  ],
  [
    'check',
    'Checks that the film is deterministic: renders sampled times twice in two orders and compares them; returns failures and preview vs final. With variants, { variants: [{ variant, ...result }] }.',
    {
      samples: say(
        num,
        "How many times to sample, 2 or more: default 20, where the CLI's check takes 50.",
      ),
      seed: say(num, 'The seed of the sampled times (default 1).'),
      hdr10: say(
        bool,
        "Check the HDR10 render of a film with hdr10 in shaderera.json (its P010, the peak and the layers' light); returns its light levels.",
      ),
      ...several,
    },
    [],
    looking('Check determinism'),
  ],
  [
    'render',
    "Writes a video (an mp4 with ffmpeg) of a window of the film, or a draft, refusing a source that is not deterministic; returns the file, frame count and seconds, and sends progress when asked. A whole film at full size is the CLI's job (npx shaderera render), in a shell.",
    {
      from: at('The start'),
      to: at('The end'),
      out: say(str, 'The file, inside the project (default under out/).'),
      draft: say(
        { oneOf: [{ type: 'number' }, { const: true }] },
        'A review render this many pixels high (true: 360), at full fps, beside the final as out/<name>-draft.mp4. Not with job.',
      ),
      job: say(
        str,
        'A job name (from the job tool): renders that frozen job instead of the working tree.',
      ),
      hdr10: say(
        bool,
        'An HDR10 mp4 (HEVC Main 10) of a film with hdr10 in shaderera.json, with its measured light levels. A job asks for it when it is made.',
      ),
      softwareGpu: say(
        bool,
        'Render on a software GPU (SwiftShader, llvmpipe, WARP: 10–100× slower), which is refused otherwise.',
      ),
      ...looks,
    },
    [],
    writing('Render a video', { destructiveHint: true, idempotentHint: true }),
  ],
  [
    'save',
    'Saves the project as a revision (versions/); returns its id. The same files always have the same id.',
    { label: say(str, 'A short name for it.'), note: say(str, 'What changed, in words.') },
    [],
    writing('Save a revision', { idempotentHint: true }),
  ],
  [
    'versions',
    'Returns the head revision, the log of saves, restores and undos, and the render jobs.',
    {},
    [],
    looking('List revisions'),
  ],
  [
    'restore',
    'Makes the project files that revision (the working tree is saved first); returns the revision now checked out.',
    { id: say(str, 'A revision id, from versions.') },
    ['id'],
    writing('Restore a revision', { destructiveHint: true }),
  ],
  [
    'undo',
    'Returns the project files to the previous revision (unsaved edits are saved first); returns the revision now checked out.',
    {},
    [],
    writing('Undo', { destructiveHint: true }),
  ],
  [
    'diff',
    'The files added, removed and changed from revision a to b (or to the working tree), and a unified patch of their text.',
    {
      a: say(str, 'A revision id, from versions.'),
      b: say(str, 'A revision id to compare with; default the working tree.'),
      stat: say(bool, 'Only the lists of files, no patch.'),
    },
    ['a'],
    looking('Compare revisions'),
  ],
  [
    'comments',
    "The person's comments on the film, as threads with their replies: { revision (the working tree's id now), head, comments: [{ id, state, revision, t, frame, to?, variant?, point?/box? with size, object?, params?, text, replies, fixedIn?, stale }] }. stale: the tree is not the one it was made on. point and box go straight into pick and render_frame region, at t.",
    {
      state: say(
        { type: 'string', enum: ['open', 'fixed', 'resolved', 'all'] },
        'Which comments (default open).',
      ),
      id: say(str, 'One comment, by id.'),
    },
    [],
    looking('Read comments'),
  ],
  [
    'comment_add',
    'Files a comment at t on the tree as it is (saved as a revision), for feedback the person gave in chat. Returns { revision, head, comments: [it] }.',
    {
      t: at(),
      to: at('The end of a span the comment covers'),
      variant: say(str, 'The variant it is about.'),
      point: say({ type: 'array', items: num }, "[x, y] in the variant's frame pixels."),
      box: say({ type: 'array', items: num }, "[x, y, w, h] in the variant's frame pixels."),
      object: say(str, 'The inspected id it is about.'),
      params: say(
        obj,
        'The params it was seen with; only those that differ from the defaults are kept.',
      ),
      text: say(str, 'The comment.'),
    },
    ['t', 'text'],
    writing('Add a comment'),
  ],
  [
    'comment_reply',
    'Replies to a comment. Returns { revision, head, comments: [it] }.',
    {
      id: say(str, 'The comment id.'),
      text: say(str, 'The reply.'),
      fixed: say(
        bool,
        'Saves the tree as a revision labelled "fix <id>: <text>" and marks the comment fixed in it; refused when nothing changed since the revision the comment was made on.',
      ),
    },
    ['id', 'text'],
    writing('Reply to a comment'),
  ],
  [
    'comment_resolve',
    'Reopens a comment, with reopen: true. Without it, refused: only the person resolves a comment, in the studio.',
    { id: say(str, 'The comment id.'), reopen: say(bool, 'Reopen it.') },
    ['id'],
    writing('Reopen a comment', { idempotentHint: true }),
  ],
  [
    'job',
    'Freezes a render job: a revision (the project is saved first unless revision is given), a variant from shaderera.json, params over the defaults, an optional window. Returns the job; render renders it.',
    {
      variant: say(str, 'A variant from shaderera.json.'),
      params: say(obj, 'Params over the defaults, name → value.'),
      revision: say(str, 'A saved revision id to freeze instead of saving the tree now.'),
      name: say(str, 'The job name.'),
      label: say(str, 'A short description.'),
      from: at('The start of the window'),
      to: at('The end of the window'),
      hdr10: say(bool, 'A job that renders an HDR10 mp4 (shaderera.json needs hdr10).'),
    },
    [],
    writing('Make a render job'),
  ],
  [
    'review',
    "Renders the shots (or 7 evenly spaced frames), transition samples and the last frame, writes a contact sheet to out/review/ and runs the technical checks (format, determinism, blank frames, end hold, text fit and overlap, glyphs, copy, assets, readback, alpha) against requirements.json; returns the report JSON plus the contact sheet and frame thumbs as images. With variants, { variants: [{ variant, ...report }] } and each one's contact sheet, each in out/review/<variant>/ (main in out/review/).",
    {
      variant: say(str, 'A variant from shaderera.json.'),
      quick: say(bool, 'Skip determinism and readback.'),
      ...several,
    },
    [],
    writing('Review the film', { idempotentHint: true }),
  ],
  [
    'studio',
    "Starts the project's studio (or reuses the one this server started) and returns its address: the page where the person watches the film and comments on it, opened in their browser. It runs as long as this server, or until stop. A studio started elsewhere is named by its pid.",
    {
      stop: say(
        bool,
        "Stop the project's studio instead, whoever started it, as shaderera studio --stop does.",
      ),
    },
    [],
    writing('Open the studio', { idempotentHint: true }),
  ],
  [
    'activity_add',
    'Adds a note of what you mean to do to the activity the studio shows. Only for what you mean to do: every tool call is recorded already. Returns the entry.',
    {
      text: say(str, 'The note, at most 4000 characters.'),
      comment: say(str, 'The id of the comment it is about.'),
    },
    ['text'],
    writing('Note what you mean to do'),
  ],
]

/** What the server tells a client about using it, once, at initialize. */
const INSTRUCTIONS = `Shaderera's tools look at and check a film made in code: a project with shaderera.json (root names it when the server runs elsewhere).
The loop: inspect or render_frame for numbers (state, hashes, boxes at t) → still to look at frames → edit the source → check that it is deterministic → render a short window or a draft.
Numbers are cheaper than pictures: images are opt-in, and at most 2048 px.
A whole film at full size renders in the CLI (npx shaderera render) in a shell, not here.
studio opens the page where the person watches and comments; comments are their notes from it: reply with comment_reply, and fixed: true once the change is made.`

/** The tools whose PNG is kept as their activity entry's image (decision 0025). */
const PICTURED = new Set(['still', 'render_frame'])
/** The tools that write comments (decision 0025). */
const COMMENT_WRITES = new Set(['comment_add', 'comment_reply', 'comment_resolve'])

/**
 * A tool call's activity entry (`by: agent`): its result and time, its error as the summary, and
 * the PNG still and render_frame returned. Never throws.
 */
const recordTool = (
  root: string,
  tool: string,
  ms: number,
  result: { content: unknown; isError?: boolean },
) => {
  const blocks = Array.isArray(result.content)
    ? (result.content as { type?: string; data?: string; text?: string }[])
    : []
  const png = PICTURED.has(tool) ? blocks.find((b) => b.type === 'image')?.data : undefined
  const error = result.isError ? (blocks[0]?.text ?? '').slice(0, 300) : undefined
  record(
    root,
    {
      by: 'agent',
      kind: 'tool',
      tool,
      ok: !result.isError,
      ms: Math.round(ms),
      summary: {
        error: error === undefined ? 0 : 1,
        warning: 0,
        info: 0,
        messages: error ? [error] : [],
      },
    },
    png ? Buffer.from(png, 'base64') : undefined,
  )
}

/** activity_add: a note, by the agent. */
const addNote = (root: string, a: { [k: string]: unknown }) => {
  if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('activity_add needs text.')
  if (a.text.length > NOTE) throw new Error(`A note is at most ${NOTE} characters.`)
  if (a.comment !== undefined && typeof a.comment !== 'string')
    throw new Error('comment is a comment id.')
  const entry = record(root, {
    by: 'agent',
    kind: 'note',
    text: a.text.trim(),
    ...(a.comment ? { comment: a.comment } : {}),
  })
  if (!entry) throw new Error(`Could not write ${root}/.shaderera/activity.jsonl.`)
  return entry
}

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
  flags: {
    trusted?: boolean
    timeout?: string
    variant?: string
    host?: string
    /** More flags for every `shaderera studio` the studio tool starts (tests: --site, --no-open). */
    studio?: readonly string[]
  } = {},
) => {
  const sessions = new Map<string, NodeSession>()
  const studio = studios([
    ...(flags.host ? ['--host', flags.host] : []),
    ...(flags.trusted ? ['--trusted'] : []),
    ...(flags.timeout ? ['--timeout', flags.timeout] : []),
    ...(flags.studio ?? []),
  ])
  // render_frame and still with a revision: its frozen copy in its own host, kept for the next call.
  const frozen = revisionHosts({
    host: flags.host,
    trusted: flags.trusted === true,
    ...(flags.timeout ? { timeoutMs: Number(flags.timeout) * 1000 } : {}),
  })
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
          checkChild(o.child, o.project.manifest, { samples: a.samples ?? 20, seed: a.seed }),
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
  /** still with file: a sheet of a rendered file's frames; no child opens for it. */
  // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
  const fileSheet = async (root: string, a: { [k: string]: any }) => {
    if (typeof a.file !== 'string') throw new Error('file is a video file inside the project.')
    for (const k of ['variant', 'variants', 'params', 'revision'])
      if (a[k] !== undefined) throw new Error(`file is read as it was rendered: no ${k}.`)
    const path = inside(root, a.file)
    const video = openFile(path)
    try {
      const given = timesOf(a.times)
      const every = typeof a.every === 'number' ? a.every : undefined
      if (given.length === 0 && every === undefined) throw new Error('still needs times or every.')
      const times = stillTimes(given, every, video.duration)
      if (times.length > SHEET)
        throw new Error(
          `${times.length} frames: a sheet holds at most ${SHEET}. Give fewer times or a longer every.`,
        )
      const label = basename(path)
      const frames = []
      for (const t of times) frames.push({ t, label, pixels: await video.frame(t) })
      const { width, height } = video
      const sheet = await contactSheet(frames, width, height)
      return [
        {
          type: 'text',
          text: JSON.stringify({ times, file: slash(relative(root, path)), width, height }),
        },
        image(sheet.toString('base64')),
      ]
    } finally {
      await video.close()
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
  /** The tools on versions/comments.jsonl: no child opens for them, and the open one stays. */
  // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
  const commentTools: { [name: string]: (root: string, a: { [k: string]: any }) => unknown } = {
    comments: (root, a) =>
      listing(root, {
        ...(typeof a.state === 'string' ? { state: a.state as CommentState } : {}),
        ...(typeof a.id === 'string' ? { id: a.id } : {}),
      }),
    comment_add: async (root, a) => {
      if (typeof a.t !== 'number') throw new Error('comment_add needs t, in seconds.')
      const c = await addComment(
        root,
        {
          t: a.t,
          text: String(a.text ?? ''),
          ...(typeof a.to === 'number' ? { to: a.to } : {}),
          ...(typeof a.variant === 'string' ? { variant: a.variant } : {}),
          ...(a.point !== undefined ? { point: a.point } : {}),
          ...(a.box !== undefined ? { box: a.box } : {}),
          ...(typeof a.object === 'string' ? { object: a.object } : {}),
          ...(a.params && typeof a.params === 'object' ? { params: a.params } : {}),
        },
        'agent',
      )
      return listing(root, { id: c.id })
    },
    comment_reply: async (root, a) => {
      const c = await replyTo(root, String(a.id), String(a.text ?? ''), {
        by: 'agent',
        fixed: a.fixed === true,
      })
      return listing(root, { id: c.id })
    },
    comment_resolve: async (root, a) => {
      const state = a.reopen === true ? 'open' : 'resolved'
      const c = await setState(root, String(a.id), state, 'agent')
      return listing(root, { id: c.id })
    },
  }
  /** A call's revision, opened (render_frame and still only). */
  const revisionOf = async (
    root: string,
    name: string,
    // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
    a: { [k: string]: any },
    params: Obj | undefined,
  ) => {
    if (a.revision === undefined) return undefined
    if (name !== 'render_frame' && name !== 'still') throw new Error(`${name} takes no revision.`)
    if (typeof a.revision !== 'string') throw new Error('revision is a revision id, from versions.')
    if (a.variants !== undefined) throw new Error('Give revision or variants, not both.')
    const variant = typeof a.variant === 'string' ? a.variant : flags.variant
    return frozen.get(root, a.revision, variant, params)
  }
  // The low-level Server does not check arguments against a tool's input schema: they come as
  // the client sent them, and each tool reads what it needs.
  const call = async (
    root: string,
    session: NodeSession,
    name: string,
    // biome-ignore lint/suspicious/noExplicitAny: unchecked arguments, read per tool
    a: { [k: string]: any },
    /** Each frame render writes, when the client asked for progress. */
    progress?: (i: number, n: number, phase?: 'recheck') => void,
  ): Promise<unknown> => {
    const onComments = commentTools[name]
    if (onComments) return onComments(root, a)
    if (name === 'still' && a.file !== undefined) return fileSheet(root, a)
    // A variant or params get their own child, closed with the call; the session's child is the
    // server's own variant (`--variant`), with the defaults.
    if (Array.isArray(a.params)) throw new Error('params is an object of name → value.')
    const params = a.params && typeof a.params === 'object' ? (a.params as Obj) : undefined
    const revision = await revisionOf(root, name, a, params)
    if (a.variants !== undefined && ['still', 'check', 'review'].includes(name))
      return forVariants(root, name, a, params)
    const variant = typeof a.variant === 'string' ? a.variant : flags.variant
    const own =
      !revision && LOOKS.has(name) && (typeof a.variant === 'string' || params)
        ? await open({ ...flags, root, variant, param: paramFlags(params) })
        : undefined
    const opened = revision ?? own ?? (await session.open())
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
              const most = a.full === true ? LONGEST : IMAGE
              const k = Math.min(1, most / Math.max(width, height))
              const size = {
                width: Math.max(1, Math.round(width * k)),
                height: Math.max(1, Math.round(height * k)),
              }
              const data =
                k === 1
                  ? png(r.pixels, width, height)
                  : (await toPng(r.pixels, width, height, most)).toString('base64')
              return [text, { type: 'text', text: JSON.stringify(size) }, image(data)]
            }
            const asked = a.scale ?? 1
            const part = crop(r.pixels, manifest, region, asked, LONGEST)
            // A region over LONGEST at scale 1 is scaled down whole.
            const k = Math.min(1, LONGEST / Math.max(part.width, part.height))
            const size = {
              width: Math.max(1, Math.round(part.width * k)),
              height: Math.max(1, Math.round(part.height * k)),
            }
            const scale = Number((part.scale * k).toFixed(3))
            const where = {
              type: 'text',
              text: JSON.stringify({
                ...size,
                region: part.region,
                scale,
                ...(scale < asked
                  ? { note: `scale ${asked} → ${scale} (long side ≤ ${LONGEST})` }
                  : {}),
              }),
            }
            const data =
              k === 1
                ? png(part.pixels, part.width, part.height)
                : (await toPng(part.pixels, part.width, part.height, LONGEST)).toString('base64')
            return [text, where, image(data)]
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
              samples: a.samples ?? 20,
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
            const draft = draftOf(a.draft)
            // A draft, a variant, params or hdr10 get their own host, closed with the call.
            const mine =
              draft !== undefined || typeof a.variant === 'string' || params || a.hdr10 === true
                ? await open({
                    ...flags,
                    root,
                    variant,
                    param: paramFlags(params),
                    ...(draft !== undefined ? { draft } : {}),
                    ...(a.hdr10 === true ? { hdr10: true } : {}),
                  })
                : undefined
            try {
              const target = mine ?? opened
              await refuseSoftware(target.child, a.softwareGpu === true, 'softwareGpu: true')
              return await exportVideo(target.project, target.child, {
                from: a.from,
                to: a.to,
                out,
                name: [
                  ...(typeof a.variant === 'string' ? [safeName(a.variant)] : []),
                  ...(draft !== undefined ? ['draft'] : []),
                ],
                revision: save(root, { by: 'agent' }).id,
                ...(progress ? { onFrame: progress } : {}),
              })
            } finally {
              await mine?.child.close()
            }
          }
          if (a.hdr10 !== undefined)
            throw new Error('A job froze its range: make a job with hdr10: true instead.')
          if (a.draft !== undefined)
            throw new Error('A draft is a review render of the working tree, never a job.')
          if (a.variant !== undefined || params)
            throw new Error('A job froze its variant and params: make a job with them instead.')
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
              ...(progress ? { onFrame: progress } : {}),
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
    } catch (e) {
      // A revision's host that failed (it died, hung, lost its GPU) is not kept for the next call.
      if (revision) await frozen.drop()
      throw e
    } finally {
      await own?.child.close()
      if (revision) frozen.rest()
    }
  }
  const server = new Server(
    { name: 'shaderera', version: shadereraVersion() },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(([name, description, properties, required, { title, ...annotations }]) => ({
      name,
      title,
      description,
      inputSchema: {
        type: 'object' as const,
        properties: {
          ...properties,
          root: say(str, "The project's folder, when the server runs outside it."),
        },
        required,
      },
      annotations: { title, ...annotations },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    // render's frames as notifications/progress, when the client asked (a progressToken): at most
    // one every PROGRESS ms, and the last.
    const token = params._meta?.progressToken
    let sent = 0
    const progress =
      token === undefined
        ? undefined
        : (i: number, n: number, phase?: 'recheck') => {
            // The frames written (i counts from 0); the re-check after them would go back to 0.
            if (phase || (i + 1 < n && performance.now() - sent < PROGRESS)) return
            sent = performance.now()
            void extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: i + 1, total: n },
              })
              .catch(() => {})
          }
    const { root, start, ...result } = await answer(params, progress)
    // Activity, once per call in a project (activity_add is its own entry), timed from when it ran.
    // A comment written is its own record: a comment tool's entry is only for its failure.
    if (
      root &&
      params.name !== 'activity_add' &&
      (!COMMENT_WRITES.has(params.name) || result.isError)
    )
      recordTool(root, params.name, performance.now() - start, result)
    return result
  })
  const answer = async (
    params: { name: string; arguments?: { [k: string]: unknown } },
    progress?: (i: number, n: number, phase?: 'recheck') => void,
  ): Promise<{ content: unknown; isError?: true; root?: string; start: number }> => {
    const a = params.arguments ?? {}
    let start = performance.now()
    let session: NodeSession | undefined
    let root: string | undefined
    try {
      const r = await serial(async () => {
        start = performance.now()
        if (!tools.some(([n]) => n === params.name)) throw new Error(`Unknown tool ${params.name}.`)
        root = (await projectOf(dir, a.root)).root
        if (params.name === 'activity_add') return addNote(root, a)
        if (params.name === 'studio') return a.stop === true ? studio.stop(root) : studio.open(root)
        session = sessionOf(root)
        const onVersions = revisions[params.name]
        if (!onVersions) return call(root, session, params.name, a, progress)
        // restore and undo replace files the child (and its clips' ffmpeg) may hold open, which
        // Windows refuses: close it first. The next call opens it again on the new files.
        if (params.name !== 'diff') await session.drop()
        return onVersions(root, a)
      })
      // A sheet of many frames can be taller than any client takes: every image is fitted.
      const content = IMAGES.has(params.name)
        ? await Promise.all(
            (r as { type: string; data?: string }[]).map(async (b) =>
              b.type === 'image' && b.data
                ? { ...b, data: (await fitted(Buffer.from(b.data, 'base64'))).toString('base64') }
                : b,
            ),
          )
        : [{ type: 'text', text: JSON.stringify(r) }]
      return { content, root, start }
    } catch (e) {
      if (/exited|took longer/.test(String(e))) void session?.drop()
      // An error in the film's code (a throw, a build error, a shader): its finding, where it is.
      const finding = errorFinding(e)
      const content = [{ type: 'text', text: (e as Error).message }]
      if (finding.file) content.push({ type: 'text', text: JSON.stringify(finding) })
      return { content, isError: true, root, start }
    }
  }
  server.onclose = () => {
    studio.close()
    for (const session of sessions.values()) session.close()
    void frozen.drop()
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
