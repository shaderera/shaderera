import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { exportFrames, frameTimes } from '@shaderera/core'
import { ffmpegSink, type Input, requireFfmpeg } from '../cli/ffmpeg.ts'
import type { Child, HostIdentity } from '../node/child.ts'
import type { Job } from '../project/jobs.ts'
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
  chunks: { index: number; from: number; to: number; frames: number; file: string }[]
}

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

/** Splits the job's window into `count` chunks of whole frames, as even as frames allow. */
export const makePlan = (job: Job, input: Input, count: number): Plan => {
  const { fps, width, height, from, to } = job.output
  const times = frameTimes(fps, from, to)
  const n = Math.max(1, Math.min(Math.floor(count), times.length))
  const chunks: Plan['chunks'] = []
  for (let i = 0; i < n; i++) {
    const a = Math.round((i * times.length) / n)
    const b = Math.round(((i + 1) * times.length) / n)
    chunks.push({
      index: i,
      // Frame times, so each chunk renders exactly its frames.
      from: times[a] as number,
      to: b < times.length ? (times[b] as number) : to,
      frames: b - a,
      file: `chunk-${String(i).padStart(3, '0')}.mkv`,
    })
  }
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
 */
export const renderChunk = async (
  child: Child,
  plan: Plan,
  index: number,
  dir: string,
  onFrame?: (i: number, n: number) => void,
): Promise<ChunkRecord> => {
  requireFfmpeg()
  const chunk = plan.chunks[index]
  if (!chunk) throw new Error(`The plan has chunks 0 to ${plan.chunks.length - 1}, not ${index}.`)
  if (plan.input === 'yuv420p' && !child.has.yuv)
    throw new Error('This plan hands frames over as yuv420p, made on the GPU: this host has none.')
  if (plan.input === 'rgba64' && !child.has.deep)
    throw new Error('This plan hands frames over at 16 bits, made on the GPU: this host has none.')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, chunk.file)
  const partial = `${out}.partial.mkv`
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
  try {
    const { frames } = await exportFrames({
      fps: plan.fps,
      from: chunk.from,
      to: chunk.to,
      render: async (t) => (await child.render(t, 'final', plan.input)).pixels,
      inspect: child.has.inspect ? (t) => child.inspect(t) : undefined,
      sink,
      onFrame,
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
 * another GPU or driver may round pixels differently and a seam would show.
 */
export const checkChunks = (plan: Plan, dir: string, mixedHosts = false): ChunkRecord[] => {
  const records = plan.chunks.map((c) => {
    const file = join(dir, c.file)
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
  if (hosts.size > 1 && !mixedHosts)
    throw new Error(
      `The chunks were rendered by ${hosts.size} different hosts (${[...hosts].join(' | ')}): another GPU or driver may round pixels differently. Render them on one kind of machine, or assemble with --mixed-hosts.`,
    )
  return records
}

/**
 * The chunks' frames in order, as the bytes the hosts handed over, decoded from the lossless
 * files one frame at a time.
 */
export async function* chunkFrames(plan: Plan, dir: string): AsyncGenerator<Uint8Array> {
  const size = frameBytes(plan.input, plan.width, plan.height)
  for (const c of plan.chunks) {
    const ff = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-i',
        join(dir, c.file),
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
    let count = 0
    for await (const data of ff.stdout as AsyncIterable<Buffer>) {
      parts.push(data)
      held += data.length
      while (held >= size) {
        const all = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, held)
        yield new Uint8Array(all.subarray(0, size))
        parts = held > size ? [all.subarray(size)] : []
        held -= size
        count++
      }
    }
    if (count !== c.frames)
      throw new Error(`${c.file} decoded to ${count} frames, not ${c.frames}.`)
  }
}
