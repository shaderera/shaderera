import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { exportFrames, frameTimes } from '@shaderera/core'
import { ffmpegSink, type Input, requireFfmpeg } from '../cli/ffmpeg.ts'
import type { Child, HostIdentity } from '../node/child.ts'
import { frameError } from '../node/open-host.ts'
import { type Job, videoOptionsOf } from '../project/jobs.ts'
import { hashFile } from '../project/revisions.ts'

/**
 * A job split into chunks of whole frames: each chunk can render on any machine that has the
 * project at the job's revision (a handoff, a checkout), into a lossless file; `assemble` then
 * encodes them once, with the whole window's sound, so the file is the one a single machine makes.
 */
export type Plan = {
  shaderera: 'plan/1'
  job: string
  jobId: string
  /** The frames as every host must hand them over: what the final encoder reads. */
  input: Input
  fps: number
  width: number
  height: number
  from: number
  to: number
  chunks: {
    index: number
    from: number
    to: number
    frames: number
    file: string
    /**
     * Frames taken from an earlier plan of the film instead of rendered (`render --reuse`):
     * `frames` frames from frame `first` of `file`, a chunk rendered for that plan's job, in the
     * plan folder `plan` (relative to this one).
     */
    reused?: { plan: string; job: string; jobId: string; first: number; sha256: string }
  }[]
}

/** The file a chunk's frames are in: this plan's folder, or the earlier plan's it reuses. */
export const chunkFile = (dir: string, c: Plan['chunks'][number]) =>
  join(c.reused ? resolve(dir, c.reused.plan) : dir, c.file)

/** What a rendered chunk records beside its file: what it was rendered for, and how. */
export type ChunkRecord = {
  index: number
  jobId: string
  input: Input
  from: number
  to: number
  frames: number
  sha256: string
  seconds: number
  host: HostIdentity
}

/** FFV1 in Matroska: lossless for every input, the bytes in are the bytes out. */
const FFV1 = { yuv420p: 'yuv420p', rgba: 'bgra', rgba64: 'rgba64le' } as const
const RAW = { yuv420p: 'yuv420p', rgba: 'rgba', rgba64: 'rgba64le' } as const

/** Bytes of one frame in an input format. */
const frameBytes = (input: Input, width: number, height: number) =>
  input === 'yuv420p' ? (width * height * 3) / 2 : width * height * (input === 'rgba64' ? 8 : 4)

/**
 * The frames a job's hosts hand over: what the final encoder reads (yuv420p or 16-bit RGBA from
 * the GPU compositor, else RGBA).
 */
export const inputOf = (job: Job, child: Child): Input =>
  videoOptionsOf(job.delivery).codec === 'h264'
    ? child.has.yuv
      ? 'yuv420p'
      : 'rgba'
    : child.has.deep
      ? 'rgba64'
      : 'rgba'

/**
 * Chunk `index` of a window's frames: frames a to b (not b) of `times`, with frame times, so the
 * chunk renders exactly its frames.
 */
export const chunkOf = (
  times: readonly number[],
  to: number,
  index: number,
  a: number,
  b: number,
) => ({
  index,
  from: times[a] as number,
  to: b < times.length ? (times[b] as number) : to,
  frames: b - a,
  file: `chunk-${String(index).padStart(3, '0')}.mkv`,
})

/** Splits the job's window into `count` chunks of whole frames, as even as frames allow. */
export const makePlan = (job: Job, input: Input, count: number): Plan => {
  const { fps, width, height, from, to } = job.output
  const times = frameTimes(fps, from, to)
  const n = Math.max(1, Math.min(Math.floor(count), times.length))
  const chunks: Plan['chunks'] = []
  for (let i = 0; i < n; i++)
    chunks.push(
      chunkOf(
        times,
        to,
        i,
        Math.round((i * times.length) / n),
        Math.round(((i + 1) * times.length) / n),
      ),
    )
  return {
    shaderera: 'plan/1',
    job: job.name,
    jobId: job.id,
    input,
    fps,
    width,
    height,
    from,
    to,
    chunks,
  }
}

export const readPlan = (dir: string): Plan => {
  const file = join(dir, 'plan.json')
  if (!existsSync(file))
    throw new Error(`No plan.json in ${resolve(dir)}: make one with shaderera plan.`)
  const plan = JSON.parse(readFileSync(file, 'utf8')) as Plan
  if (plan.shaderera !== 'plan/1')
    throw new Error(`${file} is not a plan of this Shaderera (plan/1).`)
  return plan
}

/**
 * Renders one chunk on this machine into `<dir>/<file>` (written beside it and moved into place),
 * with exportFrames's determinism re-check on its own frames, and records it in `<file>.json`.
 * Frames go round `hosts` (the first also re-checks and is recorded), two ahead a host; the
 * caller opens and closes them.
 */
export const renderChunk = async (
  hosts: readonly [Child, ...Child[]],
  plan: Plan,
  index: number,
  dir: string,
  onFrame?: (i: number, n: number) => void,
): Promise<ChunkRecord> => {
  requireFfmpeg()
  const child = hosts[0]
  const chunk = plan.chunks[index]
  if (!chunk) throw new Error(`The plan has chunks 0 to ${plan.chunks.length - 1}, not ${index}.`)
  if (chunk.reused)
    throw new Error(
      `Chunk ${index} is frames of job ${chunk.reused.job}'s plan, reused: there is nothing to render.`,
    )
  if (plan.input === 'yuv420p' && !hosts.every((h) => h.has.yuv))
    throw new Error('This plan hands frames over as yuv420p, made on the GPU: this host has none.')
  if (plan.input === 'rgba64' && !hosts.every((h) => h.has.deep))
    throw new Error('This plan hands frames over at 16 bits, made on the GPU: this host has none.')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, chunk.file)
  const partial = `${out}.${process.pid}.partial.mkv`
  const start = performance.now()
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    RAW[plan.input],
    '-s',
    `${plan.width}x${plan.height}`,
    '-i',
    '-',
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-pix_fmt',
    FFV1[plan.input],
    partial,
  ]
  // Not matted: the bytes the host hands over are the bytes stored.
  const sink = ffmpegSink(args, plan.input, false)
  let next = 0
  try {
    const { frames } = await exportFrames({
      fps: plan.fps,
      from: chunk.from,
      to: chunk.to,
      // Frames go round the hosts in the order exportFrames asks for them.
      render: async (t) => {
        const host = hosts[next++ % hosts.length] as Child
        try {
          return (await host.render(t, 'final', plan.input)).pixels
        } catch (error) {
          throw frameError(error, t, plan.fps, hosts.length)
        }
      },
      inspect: child.has.inspect ? (t) => child.inspect(t) : undefined,
      sink,
      onFrame,
      ahead: hosts.length * 2,
    })
    if (frames !== chunk.frames)
      throw new Error(`Chunk ${index} rendered ${frames} frames; the plan has ${chunk.frames}.`)
    renameSync(partial, out)
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  }
  const record: ChunkRecord = {
    index,
    jobId: plan.jobId,
    input: plan.input,
    from: chunk.from,
    to: chunk.to,
    frames: chunk.frames,
    sha256: hashFile(out),
    seconds: (performance.now() - start) / 1000,
    host: await child.identity(),
  }
  writeFileSync(`${out}.json`, `${JSON.stringify(record, null, 1)}\n`)
  return record
}

/**
 * Every chunk's record, checked: present, its file unchanged since it was rendered, rendered for
 * this plan's job, frames and input, and (unless `mixedHosts`) every chunk rendered by the same kind of host, since
 * another GPU or driver may round pixels differently and a seam would show. A reused chunk's record
 * is the earlier plan's chunk it is cut from: rendered for the job it names, still the file it was
 * when reused, and never on another kind of host, `mixedHosts` or not.
 */
export const checkChunks = (plan: Plan, dir: string, mixedHosts = false): ChunkRecord[] => {
  const hashes = new Map<string, string>()
  const hashOf = (file: string) => hashes.get(file) ?? hashes.set(file, hashFile(file)).get(file)
  const records = plan.chunks.map((c) => {
    const file = chunkFile(dir, c)
    if (c.reused) {
      const from = `job ${c.reused.job}'s plan (${resolve(dir, c.reused.plan)})`
      if (!existsSync(`${file}.json`) || !existsSync(file))
        throw new Error(`Chunk ${c.index} reuses ${c.file} of ${from}, which is gone.`)
      const r = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as ChunkRecord
      if (
        r.jobId !== c.reused.jobId ||
        r.sha256 !== c.reused.sha256 ||
        r.input !== plan.input ||
        c.reused.first + c.frames > r.frames
      )
        throw new Error(
          `${c.file} of ${from} is no longer the chunk that chunk ${c.index} reuses: render with --reuse again.`,
        )
      if (hashOf(file) !== r.sha256) throw new Error(`${file} changed after it was rendered.`)
      return r
    }
    if (!existsSync(`${file}.json`) || !existsSync(file))
      throw new Error(
        `Chunk ${c.index} is not rendered: shaderera render --job ${plan.job} --chunk ${c.index}`,
      )
    const r = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as ChunkRecord
    // A plan made again in this folder, or for a replaced job, leaves chunks of another plan.
    if (
      r.jobId !== plan.jobId ||
      r.input !== plan.input ||
      r.from !== c.from ||
      r.to !== c.to ||
      r.frames !== c.frames
    )
      throw new Error(
        `${c.file} was rendered for another plan (job ${r.jobId}, ${r.frames} frames from ${r.from} s, as ${r.input}): render it again: shaderera render --job ${plan.job} --chunk ${c.index}`,
      )
    if (hashFile(file) !== r.sha256) throw new Error(`${c.file} changed after it was rendered.`)
    return r
  })
  const hosts = new Set(records.map((r) => JSON.stringify(r.host)))
  const reused = plan.chunks.some((c) => c.reused)
  if (hosts.size > 1 && (!mixedHosts || reused))
    throw new Error(
      `The chunks were rendered by ${hosts.size} different hosts (${[...hosts].join(' | ')}): another GPU or driver may round pixels differently. Render them on one kind of machine${reused ? ', the kind that rendered the frames reused' : ', or assemble with --mixed-hosts'}.`,
    )
  return records
}

/**
 * Frames of a lossless chunk file as the bytes the host handed over, one at a time: the `count`
 * frames that `select` (an ffmpeg select expression on the frame number `n`, such as `gte(n\,12)`)
 * picks, in order.
 */
export async function* decodeFrames(
  plan: Pick<Plan, 'input' | 'width' | 'height'>,
  file: string,
  count: number,
  select?: string,
): AsyncGenerator<Uint8Array> {
  const size = frameBytes(plan.input, plan.width, plan.height)
  const ff = spawn(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-i',
      file,
      ...(select ? ['-vf', `select=${select}`, '-fps_mode', 'passthrough'] : []),
      '-frames:v',
      String(count),
      '-f',
      'rawvideo',
      '-pix_fmt',
      RAW[plan.input],
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  // The pipe's pieces, joined once per frame: joining on every read is quadratic in a frame.
  let parts: Buffer[] = []
  let held = 0
  let decoded = 0
  try {
    for await (const data of ff.stdout as AsyncIterable<Buffer>) {
      parts.push(data)
      held += data.length
      while (held >= size) {
        const all = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, held)
        yield new Uint8Array(all.subarray(0, size))
        parts = held > size ? [all.subarray(size)] : []
        held -= size
        decoded++
      }
    }
  } finally {
    ff.kill()
  }
  if (decoded !== count) throw new Error(`${file} decoded to ${decoded} frames, not ${count}.`)
}

/**
 * The chunks' frames in order, as the bytes the hosts handed over, decoded from the lossless
 * files one frame at a time; a reused chunk's from the earlier plan's file, from its first frame.
 */
export async function* chunkFrames(plan: Plan, dir: string): AsyncGenerator<Uint8Array> {
  for (const c of plan.chunks)
    yield* decodeFrames(
      plan,
      chunkFile(dir, c),
      c.frames,
      c.reused?.first ? `gte(n\\,${c.reused.first})` : undefined,
    )
}
