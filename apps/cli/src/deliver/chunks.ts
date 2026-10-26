import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { exportFrames, frameTimes } from '@shaderera/core'
import { fpsFraction, type LightLevels } from '@shaderera/core/host'
import { ffmpegSink, type Input, requireFfmpeg, stallSeconds } from '../cli/ffmpeg.ts'
import type { Child, HostIdentity } from '../node/child.ts'
import { frameError } from '../node/open-host.ts'
import { type Job, safeName, videoOptionsOf } from '../project/jobs.ts'
import { hashFile } from '../project/revisions.ts'
import { claim, holder, readClaim, removePartials } from './claim.ts'

/**
 * The frames a host hands over and a chunk stores: an SDR encoder's input, or an hdr10 render's
 * P010 (10-bit Y'CbCr 4:2:0 of PQ codes, for HEVC) or `rgb10` (its 10-bit PQ R'G'B' codes, for
 * ProRes), decision 0023.
 */
export type FrameInput = Input | 'p010' | 'rgb10'

/** Whether frames are an hdr10 render's: they come with their light levels. */
export const isHdr = (input: FrameInput): input is 'p010' | 'rgb10' =>
  input === 'p010' || input === 'rgb10'

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
  input: FrameInput
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
  input: FrameInput
  from: number
  to: number
  frames: number
  sha256: string
  seconds: number
  host: HostIdentity
  /**
   * An hdr10 chunk's light levels in cd/m², the most of its frames' (MaxCLL, MaxFALL): `assemble`
   * takes the most over the chunks and writes them into the file once.
   */
  light?: LightLevels
}

/**
 * FFV1 in Matroska: lossless for every input, the bytes in are the bytes out. P010 is stored as
 * `yuv420p10le` (FFV1 has no P010), the same 10-bit samples unpacked: decoded back to P010, every
 * byte is the host's again. `rgb10` is stored as `gbrp10le`: decoded back, every 10-bit code is the
 * host's again, and ffmpeg sets the word's two unused top bits.
 */
export const FFV1 = {
  yuv420p: 'yuv420p',
  rgba: 'bgra',
  rgba64: 'rgba64le',
  p010: 'yuv420p10le',
  rgb10: 'gbrp10le',
} as const
export const RAW = {
  yuv420p: 'yuv420p',
  rgba: 'rgba',
  rgba64: 'rgba64le',
  p010: 'p010le',
  rgb10: 'x2bgr10le',
} as const

/** Bytes of one frame in an input format. */
export const frameBytes = (input: FrameInput, width: number, height: number) =>
  input === 'yuv420p'
    ? (width * height * 3) / 2
    : input === 'p010'
      ? width * height * 3
      : width * height * (input === 'rgba64' ? 8 : 4)

/** The most of each light level over frames or chunks: what an HDR10 file declares. */
export const mostLight = (levels: readonly LightLevels[]): LightLevels => ({
  maxCll: Math.max(0, ...levels.map((l) => l.maxCll)),
  maxFall: Math.max(0, ...levels.map((l) => l.maxFall)),
})

/**
 * The frames a job's hosts hand over: what the final encoder reads (an hdr10 job's P010 for HEVC,
 * its R'G'B' codes for ProRes; yuv420p or 16-bit RGBA from the GPU compositor, else RGBA).
 */
export const inputOf = (job: Job, child: Child): FrameInput =>
  child.has.p010
    ? videoOptionsOf(job.delivery).codec === 'h264'
      ? 'p010'
      : 'rgb10'
    : videoOptionsOf(job.delivery).codec === 'h264'
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
export const makePlan = (
  job: Pick<Job, 'name' | 'id' | 'output'>,
  input: FrameInput,
  count: number,
): Plan => {
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

/** The chunk records in a plan folder (`chunk-NNN.mkv.json`), by file name. */
const chunkRecordsIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => /^chunk-\d+\.mkv\.json$/.test(f)) : []

/**
 * Refuses to write a plan of `job` into `dir` when the folder holds another job's plan, or (with no
 * plan) chunks rendered for another job: writing over it loses that plan, and its chunks could no
 * longer be assembled. A plan of the same job (by name, so a replaced job too) is made again in
 * place, as before.
 */
export const refuseOtherPlan = (dir: string, job: Pick<Job, 'name' | 'id'>) => {
  const chunks = chunkRecordsIn(dir)
  let other: string | undefined
  if (existsSync(join(dir, 'plan.json'))) {
    const plan = readPlan(dir)
    if (plan.job !== job.name) other = `job ${plan.job}'s plan`
  } else {
    const ids = new Set(
      chunks.map((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as ChunkRecord).jobId),
    )
    ids.delete(job.id)
    const [id] = ids
    if (id !== undefined) other = `chunks of another job (${id.slice(0, 8)})`
  }
  if (other === undefined) return
  // A folder beside it named after this job, that holds nothing yet.
  const name = safeName(job.name)
  let fresh = join(dirname(dir), `${name}.plan`)
  for (let n = 2; existsSync(fresh); n++) fresh = join(dirname(dir), `${name}-${n}.plan`)
  throw new Error(
    `${dir} holds ${other}${chunks.length ? ` (${chunks.length} chunk(s) rendered)` : ''}: planning job ${job.name} there would lose it. Give this plan its own folder: --out ${fresh}`,
  )
}

/**
 * Renders one chunk on this machine into `<dir>/<file>` (written beside it and moved into place),
 * with exportFrames's determinism re-check on its own frames, and records it in `<file>.json`.
 * Frames go round `hosts`, two ahead a host, and the re-check is split between them (the first
 * also inspects and is recorded); the caller opens and closes them. The chunk is claimed first
 * (claim.ts): refused while another live process renders it; once claimed, the partials earlier renders of it left are removed. The old
 * record goes before the file is replaced and the new one is written to a temp file and renamed,
 * so a file is never paired with another render's record. `signal` (Ctrl-C) stops it between
 * frames, leaving no partial and no claim.
 */
export const renderChunk = async (
  hosts: readonly [Child, ...Child[]],
  plan: Plan,
  index: number,
  dir: string,
  onFrame?: (i: number, n: number, phase?: 'recheck') => void,
  signal?: AbortSignal,
): Promise<ChunkRecord> => {
  requireFfmpeg()
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
  if (isHdr(plan.input) && !hosts.every((h) => h.has.p010))
    throw new Error(
      `This plan hands frames over as HDR10 ${plan.input}: this host does not render the job in hdr10.`,
    )
  mkdirSync(dir, { recursive: true })
  const out = join(dir, chunk.file)
  const claimed = claim(dir, chunk.file)
  try {
    // Nobody else renders this chunk now: whatever earlier renders of it left goes.
    removePartials(out, '.partial.mkv', true)
    removePartials(`${out}.json`, '.tmp', true)
    return await renderClaimed(hosts, plan, chunk, out, claimed.ours, onFrame, signal)
  } finally {
    claimed.release()
  }
}

/** renderChunk's render, once the chunk is claimed. */
const renderClaimed = async (
  hosts: readonly [Child, ...Child[]],
  plan: Plan,
  chunk: Plan['chunks'][number],
  out: string,
  ours: () => boolean,
  onFrame?: (i: number, n: number, phase?: 'recheck') => void,
  signal?: AbortSignal,
): Promise<ChunkRecord> => {
  const child = hosts[0]
  const index = chunk.index
  const partial = `${out}.${process.pid}.partial.mkv`
  const json = `${out}.json`
  const temp = `${json}.${process.pid}.tmp`
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
    // The job's rate, not rawvideo's 25: the file's timestamps are its frames' (#442).
    '-framerate',
    fpsFraction(plan.fps),
    '-i',
    '-',
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-pix_fmt',
    FFV1[plan.input],
    // No random segment UID, date or version string: the same frames give the same file, so a
    // chunk rendered again is still the one a reuse plan recorded by its sha256.
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    partial,
  ]
  // Not matted: the bytes the host hands over are the bytes stored.
  const sink = ffmpegSink(args, plan.input, false, { handOver: true })
  // An hdr10 chunk's light: every frame's, the determinism re-check's renders too (the same).
  const light: LightLevels[] = []
  try {
    const { frames } = await exportFrames({
      fps: plan.fps,
      from: chunk.from,
      to: chunk.to,
      // exportFrames sends the frames round the hosts, and splits its re-check between them.
      render: async (t, host) => {
        try {
          const r = await (hosts[host] as Child).render(t, 'final', plan.input)
          if (r.light) light.push(r.light)
          return r.pixels
        } catch (error) {
          throw frameError(error, t, plan.fps, hosts.length)
        }
      },
      inspect: child.has.inspect ? (t) => child.inspect(t) : undefined,
      sink,
      onFrame: onFrame && ((i, n) => onFrame?.(i, n)),
      onRecheck: onFrame && ((i, n) => onFrame?.(i, n, 'recheck')),
      signal,
      ahead: hosts.length * 2,
      hosts: hosts.length,
    })
    if (isHdr(plan.input) && light.length < frames)
      throw new Error(`Chunk ${index}'s host gave no light levels with its ${plan.input} frames.`)
    if (frames !== chunk.frames)
      throw new Error(`Chunk ${index} rendered ${frames} frames; the plan has ${chunk.frames}.`)
    const record: ChunkRecord = {
      index,
      jobId: plan.jobId,
      input: plan.input,
      from: chunk.from,
      to: chunk.to,
      frames: chunk.frames,
      sha256: hashFile(partial),
      seconds: (performance.now() - start) / 1000,
      host: await child.identity(),
      ...(isHdr(plan.input) ? { light: mostLight(light) } : {}),
    }
    writeFileSync(temp, `${JSON.stringify(record, null, 1)}\n`)
    if (!ours())
      throw new Error(`${chunk.file}'s claim was taken over by another render while this one ran.`)
    // The old record first: between the renames the chunk reads as not rendered, never as this
    // file with another render's record.
    rmSync(json, { force: true })
    renameSync(partial, out)
    renameSync(temp, json)
    return record
  } catch (error) {
    rmSync(partial, { force: true })
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Where a chunk of a plan stands: `done` (its record and file are there, rendered for this plan),
 * `verified` (done, and the file's sha256 checked again), `changed` (the file differs from its
 * record), `stale` (the record is of another job or plan), `partial` (not rendered, but a render
 * of it stopped part way and left a `.partial`), `missing`, or `claimed` (not done, and a live
 * render holds its claim: claim.ts).
 */
export type ChunkStatus =
  | 'done'
  | 'verified'
  | 'changed'
  | 'stale'
  | 'partial'
  | 'missing'
  | 'claimed'

export type ChunkState = {
  index: number
  file: string
  frames: number
  status: ChunkStatus
  /** The record beside the file, when there is one. */
  record?: ChunkRecord
  /** `.partial` files a render of this chunk left. */
  partials: string[]
  /** Who renders a claimed chunk. */
  claim?: { host?: string; pid?: number; at?: string }
  /** For a reused chunk: the earlier plan's folder and job. */
  reused?: { plan: string; job: string }
  /** Why the chunk cannot be assembled as it is. */
  problem?: string
  /** The command that renders it again. */
  fix?: string
}

/** The command that renders chunk `index` of the plan in `dir`. */
export const renderCommand = (plan: Pick<Plan, 'job'>, dir: string, index: number) =>
  `shaderera render --job ${plan.job} --chunk ${index} --plan ${resolve(dir)}`

/**
 * Every chunk of the plan in `dir` and where it stands, without throwing. With `verify` each
 * file's sha256 is checked against its record (`verified` or `changed`); without, a chunk whose
 * record and file are there and match the plan is `done`. A reused chunk's record is the earlier
 * plan's chunk it is cut from: rendered for the job it names and still the file it was when reused.
 */
export const chunkStates = (plan: Plan, dir: string, verify = false): ChunkState[] => {
  const hashes = new Map<string, string>()
  const hashOf = (file: string) => hashes.get(file) ?? hashes.set(file, hashFile(file)).get(file)
  const names = existsSync(dir) ? readdirSync(dir) : []
  const stateOf = (c: Plan['chunks'][number]): ChunkState => {
    const file = chunkFile(dir, c)
    const partials = c.reused
      ? []
      : names
          .filter((f) => f.startsWith(`${c.file}.`) && f.endsWith('.partial.mkv'))
          .map((f) => join(dir, f))
    const base = { index: c.index, file, frames: c.frames, partials }
    let record: ChunkRecord | undefined
    try {
      if (existsSync(file)) record = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as ChunkRecord
    } catch {
      // No record, or one cut short: the chunk is not rendered.
    }
    if (c.reused) {
      const reused = { plan: resolve(dir, c.reused.plan), job: c.reused.job }
      const from = `job ${c.reused.job}'s plan (${reused.plan})`
      if (!record)
        return {
          ...base,
          reused,
          status: 'missing',
          problem: `Chunk ${c.index} reuses ${c.file} of ${from}, which is gone.`,
        }
      if (
        record.jobId !== c.reused.jobId ||
        record.sha256 !== c.reused.sha256 ||
        record.input !== plan.input ||
        c.reused.first + c.frames > record.frames
      )
        return {
          ...base,
          reused,
          record,
          status: 'stale',
          problem: `${c.file} of ${from} is no longer the chunk that chunk ${c.index} reuses: render with --reuse again.`,
        }
      if (!verify) return { ...base, reused, record, status: 'done' }
      return hashOf(file) === record.sha256
        ? { ...base, reused, record, status: 'verified' }
        : {
            ...base,
            reused,
            record,
            status: 'changed',
            problem: `${file} changed after it was rendered.`,
          }
    }
    const fix = renderCommand(plan, dir, c.index)
    if (!record)
      return {
        ...base,
        status: partials.length > 0 ? 'partial' : 'missing',
        problem: `Chunk ${c.index} is not rendered${partials.length > 0 ? ' (a render of it stopped part way)' : ''}`,
        fix,
      }
    // A plan made again in this folder, or for a replaced job, leaves chunks of another plan.
    if (
      record.jobId !== plan.jobId ||
      record.input !== plan.input ||
      record.from !== c.from ||
      record.to !== c.to ||
      record.frames !== c.frames
    )
      return {
        ...base,
        record,
        status: 'stale',
        problem: `${c.file} was rendered for another plan (job ${record.jobId}, ${record.frames} frames from ${record.from} s, as ${record.input}): render it again`,
        fix,
      }
    if (!verify) return { ...base, record, status: 'done' }
    return hashFile(file) === record.sha256
      ? { ...base, record, status: 'verified' }
      : {
          ...base,
          record,
          status: 'changed',
          problem: `${c.file} changed after it was rendered`,
          fix,
        }
  }
  return plan.chunks.map((c) => {
    const state = stateOf(c)
    if (c.reused || state.status === 'done' || state.status === 'verified') return state
    // Being rendered now: whatever it was, a live render is replacing it.
    const held = readClaim(dir, c.file)
    if (!held?.live) return state
    const { fix: _, ...rest } = state
    return {
      ...rest,
      status: 'claimed',
      claim: { host: held.host, pid: held.pid, at: held.at },
      problem: `${c.file} is being rendered by ${holder(held)}`,
    }
  })
}

/** A chunk's problem as a line, with the command that fixes it. */
const problemLine = (s: ChunkState) => `${s.problem}${s.fix ? `: ${s.fix}` : ''}`

/**
 * Every chunk's record, checked (chunkStates with `verify`): present, its file unchanged since it
 * was rendered, rendered for this plan's job, frames and input, and (unless `mixedHosts`) every
 * chunk rendered by the same kind of host, since another GPU or driver may round pixels
 * differently and a seam would show. A reused chunk is never on another kind of host,
 * `mixedHosts` or not. Throws once with every problem, each with the command that fixes it.
 */
export const checkChunks = (plan: Plan, dir: string, mixedHosts = false): ChunkRecord[] => {
  const states = chunkStates(plan, dir, true)
  const problems = states.flatMap((s) => (s.problem ? [problemLine(s)] : []))
  const records = states.flatMap((s) => (s.record ? [s.record] : []))
  // An HDR10 file declares the light its chunks measured: a chunk without it cannot be assembled.
  if (isHdr(plan.input))
    for (const s of states)
      if (s.record && !s.record.light)
        problems.push(
          `Chunk ${s.index} records no light levels${s.fix ? `: ${s.fix}` : ', render it again'}`,
        )
  const hosts = new Set(records.map((r) => JSON.stringify(r.host)))
  const reused = plan.chunks.some((c) => c.reused)
  if (hosts.size > 1 && (!mixedHosts || reused))
    problems.push(
      `The chunks were rendered by ${hosts.size} different hosts (${[...hosts].join(' | ')}): another GPU or driver may round pixels differently. Render them on one kind of machine${reused ? ', the kind that rendered the frames reused' : ', or assemble with --mixed-hosts'}.`,
    )
  if (problems.length === 1) throw new Error(problems[0])
  if (problems.length > 1)
    throw new Error(
      `${problems.length} problems in the plan in ${resolve(dir)}:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
  return records
}

/** Frames done of the plan's total, and seconds left at the pace its rendered chunks recorded. */
export const progressOf = (plan: Plan, states: readonly ChunkState[]) => {
  const ok = (s: ChunkState) => s.status === 'done' || s.status === 'verified'
  const total = plan.chunks.reduce((n, c) => n + c.frames, 0)
  const done = states.filter(ok).reduce((n, s) => n + s.frames, 0)
  // The pace of chunks rendered for this plan (a changed file took its time all the same);
  // reused frames took no time here.
  const timed = states.filter((s) => (ok(s) || s.status === 'changed') && !s.reused)
  const frames = timed.reduce((n, s) => n + s.frames, 0)
  const seconds = timed.reduce((n, s) => n + (s.record?.seconds ?? 0), 0)
  const left = states.filter((s) => !ok(s) && !s.reused).reduce((n, s) => n + s.frames, 0)
  return { done, total, eta: left === 0 ? 0 : frames > 0 ? (seconds / frames) * left : null }
}

/** How long a decoder's output may go on after it exited before it is given up. */
const EXIT_GRACE_MS = 5000

/**
 * Frames of a lossless chunk file as the bytes the host handed over, one at a time: the `count`
 * frames that `select` (an ffmpeg select expression on the frame number `n`, such as `gte(n\,12)`)
 * picks, in order.
 *
 * The frames are counted, not read to the pipe's end: another process can hold the pipe open
 * after ffmpeg exits (node/spawn-turn.ts), and its end never comes. An output that goes quiet
 * fails instead of waiting: `stall` seconds while ffmpeg runs (stallSeconds), `grace` ms once it
 * has exited.
 */
export async function* decodeFrames(
  plan: Pick<Plan, 'input' | 'width' | 'height'>,
  file: string,
  count: number,
  select?: string,
  /** For tests: another program in ffmpeg's place (`command` then the args), other allowances. */
  o: { command?: readonly string[]; stall?: number; grace?: number } = {},
): AsyncGenerator<Uint8Array> {
  const size = frameBytes(plan.input, plan.width, plan.height)
  const [bin = 'ffmpeg', ...pre] = o.command ?? []
  const ff = spawn(
    bin,
    [
      ...pre,
      '-loglevel',
      'error',
      '-i',
      file,
      ...(select ? ['-vf', `select=${select}`] : []),
      // Each frame of the file once, whatever its timestamps say: frames are counted, and a
      // chunk rendered before #442 says 25 fps whatever the job's rate.
      '-fps_mode',
      'passthrough',
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
  // Not timed while a frame is out with the caller (an encoder may take its time).
  let waiting = false
  let exited: string | undefined
  let timer: NodeJS.Timeout | undefined
  const stall = o.stall ?? stallSeconds()
  const watch = () => {
    clearTimeout(timer)
    if (!waiting) return
    const [ms, why] =
      exited === undefined
        ? [
            stall * 1000,
            `Decoding ${file}: ffmpeg gave no frame for ${stall} s: it stalled (SHADERERA_FFMPEG_STALL sets the seconds).`,
          ]
        : [
            o.grace ?? EXIT_GRACE_MS,
            `Decoding ${file}: ffmpeg exited (${exited}) after ${decoded} of its ${count} frames, and its output did not end.`,
          ]
    timer = setTimeout(() => ff.stdout?.destroy(new Error(why)), ms)
  }
  ff.once('exit', (code, signal) => {
    exited = String(code ?? signal)
    watch()
  })
  try {
    if (count === 0) return
    waiting = true
    watch()
    for await (const data of ff.stdout as AsyncIterable<Buffer>) {
      waiting = false
      clearTimeout(timer)
      parts.push(data)
      held += data.length
      while (held >= size && decoded < count) {
        const all = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, held)
        yield new Uint8Array(all.subarray(0, size))
        parts = held > size ? [all.subarray(size)] : []
        held -= size
        decoded++
      }
      if (decoded === count) return
      waiting = true
      watch()
    }
  } finally {
    clearTimeout(timer)
    ff.kill()
  }
  if (decoded !== count)
    throw new Error(`Decoding ${file}: ffmpeg gave ${decoded} frames, not ${count}.`)
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
