import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { frameTimes, type Manifest } from '@shaderera/core'
import type { Child } from '../node/child.ts'
import type { Job } from '../project/jobs.ts'
import {
  type ChunkRecord,
  checkChunks,
  chunkFile,
  chunkOf,
  decodeFrames,
  inputOf,
  makePlan,
  type Plan,
  readPlan,
  renderChunk,
} from './chunks.ts'

/** Frames a to b of a window, both included. */
type Span = [number, number]

const seconds = (t: number) => `${Number(t.toFixed(4))}`

/**
 * `--changed 1.5-2.5,10-11` as frames of a window's `times`: each changed span widened to whole
 * frames (every frame whose time, t to t + 1/fps, meets it), then forward by the source's lookback
 * (to the window's end for `sequential: true`), and kept inside the window.
 */
export const changedSpans = (
  given: string,
  times: readonly number[],
  fps: number,
  sequential: Manifest['sequential'],
): Span[] => {
  const first = Math.round((times[0] ?? 0) * fps)
  const lookback = sequential === true ? Number.POSITIVE_INFINITY : (sequential ?? 0)
  return given.split(',').flatMap((s): Span[] => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(s)
    const a = Number(m?.[1])
    const b = Number(m?.[2])
    if (!m || !(b > a))
      throw new Error(`--changed takes spans in seconds, from-to, such as 1.5-2.5: not "${s}".`)
    const lo = Math.max(0, Math.floor(a * fps + 1e-9) - first)
    const hi = Math.min(times.length - 1, Math.ceil(b * fps - 1e-9) - 1 - first + lookback)
    return lo <= hi ? [[lo, hi]] : []
  })
}

/** Where a window frame of the earlier plan is: frames from `start` are `file`'s from `first`. */
type Origin = {
  start: number
  frames: number
  dir: string
  file: string
  first: number
  job: string
  jobId: string
  sha256: string
}

/** The earlier plan's chunks as origins, a reused chunk's as the chunk it was cut from. */
const originsOf = (old: Plan, oldDir: string, records: ChunkRecord[]): Origin[] => {
  let start = 0
  return old.chunks.map((c, i) => {
    const o = {
      start,
      frames: c.frames,
      dir: c.reused ? resolve(oldDir, c.reused.plan) : oldDir,
      file: c.file,
      first: c.reused?.first ?? 0,
      job: c.reused?.job ?? old.job,
      jobId: c.reused?.jobId ?? old.jobId,
      sha256: (records[i] as ChunkRecord).sha256,
    }
    start += c.frames
    return o
  })
}

/**
 * The new plan's chunks: one to render for every run of changed frames, and the frames between
 * taken from the earlier plan, one chunk for each of its files they are cut from.
 */
const layout = (
  times: readonly number[],
  to: number,
  changed: readonly boolean[],
  origins: readonly Origin[],
  dir: string,
): Plan['chunks'] => {
  const chunks: Plan['chunks'] = []
  for (let a = 0; a < times.length; ) {
    let b = a
    while (b < times.length && changed[b] === changed[a]) b++
    if (changed[a]) chunks.push(chunkOf(times, to, chunks.length, a, b))
    else
      for (const o of origins) {
        const lo = Math.max(a, o.start)
        const hi = Math.min(b, o.start + o.frames)
        if (lo < hi)
          chunks.push({
            ...chunkOf(times, to, chunks.length, lo, hi),
            file: o.file,
            reused: {
              // Relative and with forward slashes, so the plans can move together.
              plan: relative(dir, o.dir).split(sep).join('/'),
              job: o.job,
              jobId: o.jobId,
              first: o.first + lo - o.start,
              sha256: o.sha256,
            },
          })
      }
    a = b
  }
  return chunks
}

/**
 * The reused frames to render again and compare with the earlier plan's: the first and last of
 * every run of them, and about one every 10 s spread evenly over them all.
 */
const samplesOf = (changed: readonly boolean[], fps: number): number[] => {
  const reused = changed.flatMap((c, i) => (c ? [] : [i]))
  const picked = new Set(reused.filter((i) => changed[i - 1] !== false || changed[i + 1] !== false))
  const spread = Math.ceil(reused.length / (10 * fps))
  for (let k = 0; k < spread; k++)
    picked.add(reused[Math.floor(((k + 0.5) * reused.length) / spread)] as number)
  return [...picked].sort((x, y) => x - y)
}

/**
 * Renders `frames` (reused ones, ascending) from the new revision and compares each, byte for byte,
 * with the earlier plan's frame it would reuse; records whether they are the same in `checked`.
 */
const compare = async (
  child: Child,
  plan: Plan,
  dir: string,
  times: readonly number[],
  frames: readonly number[],
  checked: Map<number, boolean>,
) => {
  let start = 0
  for (const c of plan.chunks) {
    const picks = frames.filter((f) => f >= start && f < start + c.frames)
    if (c.reused && picks.length > 0) {
      const first = c.reused.first - start
      const select = picks.map((f) => `eq(n\\,${first + f})`).join('+')
      let i = 0
      for await (const old of decodeFrames(plan, chunkFile(dir, c), picks.length, select)) {
        const f = picks[i++] as number
        const now = (await child.render(times[f] as number, 'final', plan.input)).pixels
        checked.set(f, Buffer.from(now.buffer, now.byteOffset, now.byteLength).equals(old))
      }
    }
    start += c.frames
  }
}

/**
 * `render --job <name> --reuse <plan> --changed <from>-<to>[,…] [--fix]`: a plan of the job that
 * renders only its changed spans and takes every other frame from an earlier plan of the film,
 * cut out of its lossless chunks, so `assemble` encodes the same file a full render would.
 *
 * Refuses an earlier plan of another format or window, or rendered on another kind of host than
 * this one. Before anything renders, it renders a sample of the reused frames from the new
 * revision (samplesOf) and compares them with the earlier frames; a frame that differs is refused,
 * named with its span, or with `fix` the frames around it no sample vouches for become changed
 * (and forward by the lookback), and the new boundaries are sampled again. Then it writes
 * `plan.json` into `dir` and renders the changed spans' chunks there.
 */
export const renderReusing = async (
  child: Child,
  job: Job,
  manifest: Manifest,
  o: {
    reuse: string
    changed: string
    fix: boolean
    dir: string
    onFrame?: (i: number, n: number) => void
    /** More hosts the changed chunks' frames go round, besides `child`: the caller closes them. */
    extra?: readonly Child[]
  },
): Promise<{ plan: Plan; rendered: ChunkRecord[]; samples: number; fixed: number[] }> => {
  const oldDir = resolve(o.reuse)
  if (oldDir === resolve(o.dir))
    throw new Error(
      `${oldDir} is the plan this render writes: give the new one its own folder with --plan <dir>.`,
    )
  const old = readPlan(oldDir)
  const plan = makePlan(job, inputOf(job, child), 1)
  const looks = (p: Plan) =>
    `${p.width}×${p.height} at ${p.fps} fps, ${seconds(p.from)}–${seconds(p.to)} s, frames as ${p.input}`
  if ((['input', 'width', 'height', 'fps', 'from', 'to'] as const).some((k) => plan[k] !== old[k]))
    throw new Error(
      `The earlier plan (job ${old.job}) is ${looks(old)}, and job ${job.name} is ${looks(plan)}: frames are reused only between plans of the same format and window.`,
    )
  const records = checkChunks(old, oldDir)
  const host = JSON.stringify(await child.identity())
  const other = records.map((r) => JSON.stringify(r.host)).find((h) => h !== host)
  if (other)
    throw new Error(
      `The earlier plan's frames were rendered by ${other}, and this host is ${host}: another GPU or driver may round pixels differently, so frames are reused only on the same kind of host. Render there, or render the whole job.`,
    )
  const times = frameTimes(plan.fps, plan.from, plan.to)
  const lookback = manifest.sequential === true ? times.length : (manifest.sequential ?? 0)
  const changed = times.map(() => false)
  for (const [a, b] of changedSpans(o.changed, times, plan.fps, manifest.sequential))
    changed.fill(true, a, b + 1)
  const origins = originsOf(old, oldDir, records)
  const checked = new Map<number, boolean>()
  const fixed: number[] = []
  for (;;) {
    plan.chunks = layout(times, plan.to, changed, origins, o.dir)
    const samples = samplesOf(changed, plan.fps).filter((f) => !checked.has(f))
    await compare(child, plan, o.dir, times, samples, checked)
    const differ = [...checked].flatMap(([f, same]) => (same || changed[f] ? [] : [f]))
    if (differ.length === 0) break
    if (!o.fix) {
      const spanOf = (f: number) => {
        let a = f
        let b = f
        while (a > 0 && !changed[a - 1]) a--
        while (b + 1 < times.length && !changed[b + 1]) b++
        return `${seconds(times[a] as number)}–${seconds(times[b + 1] ?? plan.to)} s`
      }
      throw new Error(
        `Outside the changed spans, the new revision draws other frames than the earlier plan: ${differ.map((f) => `frame ${f} (t ${seconds(times[f] as number)} s) in the unchanged span ${spanOf(f)}`).join(', ')}. Give --changed spans that cover the edit, or --fix to render around those frames.`,
      )
    }
    // Every frame around one that differs, up to the nearest sample that matched or changed frame.
    const vouched = (f: number) => changed[f] || checked.get(f) === true
    for (const f of differ) {
      let a = f
      let b = f
      while (a > 0 && !vouched(a - 1)) a--
      while (b + 1 < times.length && !vouched(b + 1)) b++
      changed.fill(true, a, Math.min(times.length, b + 1 + lookback))
      fixed.push(f)
    }
  }
  mkdirSync(o.dir, { recursive: true })
  writeFileSync(join(o.dir, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
  const rendered: ChunkRecord[] = []
  for (const c of plan.chunks)
    if (!c.reused)
      rendered.push(await renderChunk([child, ...(o.extra ?? [])], plan, c.index, o.dir, o.onFrame))
  const samples = [...checked].filter(([f, same]) => same && !changed[f]).length
  return { plan, rendered, samples, fixed }
}
