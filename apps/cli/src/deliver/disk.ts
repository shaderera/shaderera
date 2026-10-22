import { spawn } from 'node:child_process'
import { existsSync, statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { frameTimes } from '@shaderera/core'
import { bitsPerSecond, type Input } from '../cli/ffmpeg.ts'
import { found } from '../cli/findings.ts'
import type { Child } from '../node/child.ts'
import type { Delivery, Job } from '../project/jobs.ts'
import { FFV1, type FrameInput, frameBytes, type Plan, RAW } from './chunks.ts'
import { encodePng } from './png.ts'

/**
 * The disk-space preflight (#285): before `plan`, `render --chunk`, `deliver` and a png job write
 * anything, the bytes they will write are estimated and compared with the free space on the
 * volume they write to. Not enough is refused, naming both and `--force`; less than a margin left
 * over is a warning. The estimate is a finding (`disk`) in the `--json` envelope either way.
 */

/** Bytes this user may still write on the volume that holds `dir`. */
export type FreeSpace = (dir: string) => number

/** fs.statfs on `dir`, or the nearest folder above it that exists (it may not be made yet). */
export const statfsFree: FreeSpace = (dir) => {
  let at = resolve(dir)
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  const s = statfsSync(at)
  return Number(s.bavail) * Number(s.bsize)
}

let reader: FreeSpace = statfsFree

/** Replaces the free-space reader (tests); no argument puts statfs back. */
export const setFreeSpace = (f: FreeSpace = statfsFree) => {
  reader = f
}

/** Bytes as GB (or MB under one). */
export const size = (n: number) =>
  n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(1)} GB`

/** What a preflight found: the estimate, the free space, and what is left over after. */
export type DiskCheck = {
  dir: string
  /** Bytes the command is estimated to write. */
  need: number
  free: number
  /** How the frames were estimated: from frames rendered as samples, or the raw-pixel ceiling. */
  basis: 'sampled' | 'ceiling' | 'bitrate'
  status: 'ok' | 'low' | 'refused' | 'forced'
}

/**
 * Compares `need` bytes with the free space where `dir` is: refuses (throws) when they do not fit
 * unless `force`, warns when less than a quarter of the estimate (at least 1 GB) would be left.
 */
export const checkDisk = (
  what: string,
  o: { dir: string; need: number; basis: DiskCheck['basis']; force?: boolean },
): DiskCheck => {
  const free = reader(o.dir)
  const margin = Math.max(1e9, o.need / 4)
  const status: DiskCheck['status'] =
    o.need > free ? (o.force ? 'forced' : 'refused') : free - o.need < margin ? 'low' : 'ok'
  const basis = {
    sampled: 'from sampled frames',
    ceiling: 'raw-pixel ceiling',
    bitrate: 'by bitrate',
  }[o.basis]
  const measured = `about ${size(o.need)} to write (${basis}), ${size(free)} free on ${o.dir}`
  const message =
    status === 'refused'
      ? `Not enough disk space for ${what}: ${measured}. Free some space, write elsewhere (--out or --plan), or add --force to go ahead anyway.`
      : status === 'forced'
        ? `${what} may fill the disk: ${measured} (--force).`
        : status === 'low'
          ? `${what} leaves little disk space: ${measured}.`
          : `${what}: ${measured}.`
  found({
    code: 'disk',
    severity: status === 'refused' ? 'error' : status === 'ok' ? 'info' : 'warning',
    message,
    measured,
  })
  if (status === 'refused') throw new Error(message)
  if (status !== 'ok') console.warn(`! ${message}`)
  return { dir: o.dir, need: o.need, free, basis: o.basis, status }
}

/** `n` frame times spread over `times`, the middle of each nth part (fewer when there are fewer). */
export const sampleTimes = (times: readonly number[], n = 3): number[] => {
  const k = Math.min(n, times.length)
  return Array.from(
    { length: k },
    (_, i) => times[Math.floor(((i + 0.5) * times.length) / k)] as number,
  )
}

/** Bytes FFV1 (as a plan's chunks store it) takes for these frames. */
const ffv1Bytes = (
  frames: readonly Uint8Array[],
  input: FrameInput,
  width: number,
  height: number,
) =>
  new Promise<number>((done, fail) => {
    const ff = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        RAW[input],
        '-s',
        `${width}x${height}`,
        '-i',
        '-',
        '-c:v',
        'ffv1',
        '-level',
        '3',
        '-pix_fmt',
        FFV1[input],
        '-f',
        'matroska',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    let n = 0
    ff.stdout.on('data', (d: Buffer) => {
      n += d.length
    })
    ff.on('error', fail)
    ff.on('close', (code) => (code === 0 ? done(n) : fail(new Error(`ffmpeg exited ${code}`))))
    ff.stdin.on('error', () => {})
    for (const f of frames) ff.stdin.write(f)
    ff.stdin.end()
  })

/**
 * Bytes a frame takes as a lossless intermediate (`ffv1`, a plan's chunk; `png`, a png job's
 * frame): the mean of a few frames rendered with `render` and encoded, or the raw ceiling (the
 * bytes handed over, frameBytes: an hdr10 render's P010 twice yuv420p's, its rgb10 rgba's) when
 * there is no `render` (a sequential source, whose frames mid-film replay from its start) or a
 * sample fails (the render itself will say why).
 */
export const frameEstimate = async (
  kind: 'ffv1' | 'png',
  o: {
    input: FrameInput
    width: number
    height: number
    times: readonly number[]
    render?: (t: number) => Promise<Uint8Array>
  },
): Promise<{ bytes: number; basis: 'sampled' | 'ceiling' }> => {
  const ceiling = { bytes: frameBytes(o.input, o.width, o.height), basis: 'ceiling' as const }
  const at = sampleTimes(o.times)
  if (!o.render || at.length === 0) return ceiling
  try {
    const frames: Uint8Array[] = []
    for (const t of at) frames.push(await o.render(t))
    const total =
      kind === 'png'
        ? frames.reduce(
            (n, f) => n + encodePng(f, o.width, o.height, o.input === 'rgba64' ? 16 : 8).length,
            0,
          )
        : await ffv1Bytes(frames, o.input, o.width, o.height)
    return { bytes: Math.ceil(total / frames.length), basis: 'sampled' }
  } catch {
    return ceiling
  }
}

/** WAV PCM, 48 kHz, 24-bit stereo: bytes a second (a png job's audio.wav, a mov's audio). */
const PCM = 48000 * 3 * 2

/**
 * Bits a pixel a frame a final file takes, rough and on the high side: H.264 by crf (review, master),
 * ProRes from Apple's published rates at 1080p29.97 (HQ about 220 Mb/s, 4444 about 330).
 */
const BITS_PER_PIXEL = { review: 0.5, master: 1, 'prores-hq': 3.6, 'prores-4444': 5.4 }

/**
 * Bytes of a final video file (mp4 or mov) with its sound: by `--bitrate`/`--maxrate` when given,
 * else by BITS_PER_PIXEL.
 */
export const finalFileBytes = (
  d: Pick<Delivery, 'format' | 'quality' | 'bitrate' | 'maxrate'>,
  o: { width: number; height: number; fps: number; seconds: number },
): number => {
  const mov = d.format === 'prores-hq' || d.format === 'prores-4444'
  const rate = d.bitrate ?? d.maxrate
  const video = rate
    ? bitsPerSecond(rate) / 8
    : (BITS_PER_PIXEL[mov ? (d.format as 'prores-hq' | 'prores-4444') : d.quality] *
        o.width *
        o.height *
        o.fps) /
      8
  return Math.ceil((video + (mov ? PCM : 40_000)) * o.seconds)
}

/** Bytes of a png job's handoff besides its frames: audio.wav (stems at most double it). */
export const handoffAudioBytes = (seconds: number, stems = false) =>
  Math.ceil(PCM * seconds * (stems ? 2 : 1))

/** A host's frames at `t` as `input`, for samples; none for a sequential source (the ceiling). */
const sampler = (child: Child, input: FrameInput, sequential: unknown) =>
  sequential ? undefined : async (t: number) => (await child.render(t, 'final', input)).pixels

/** `plan`: every chunk it will render as FFV1, and the file `assemble` writes, in the plan folder. */
export const preflightPlan = async (
  child: Child,
  job: Job,
  plan: Plan,
  dir: string,
  o: { sequential?: unknown; force?: boolean },
) => {
  const { width, height, fps, from, to } = job.output
  const frame = await frameEstimate('ffv1', {
    input: plan.input,
    width,
    height,
    times: frameTimes(fps, from, to),
    render: sampler(child, plan.input, o.sequential),
  })
  const frames = plan.chunks.filter((c) => !c.reused).reduce((n, c) => n + c.frames, 0)
  const need =
    frames * frame.bytes + finalFileBytes(job.delivery, { width, height, fps, seconds: to - from })
  return checkDisk(`plan ${job.name}`, { dir, need, basis: frame.basis, force: o.force })
}

/** `render --chunk`: the chunk's FFV1 file, in the plan folder. */
export const preflightChunk = async (
  child: Child,
  plan: Plan,
  index: number,
  dir: string,
  o: { sequential?: unknown; force?: boolean },
) => {
  const chunk = plan.chunks[index]
  if (!chunk || chunk.reused) return undefined
  const frame = await frameEstimate('ffv1', {
    input: plan.input,
    width: plan.width,
    height: plan.height,
    times: frameTimes(plan.fps, chunk.from, chunk.to),
    render: sampler(child, plan.input, o.sequential),
  })
  return checkDisk(`chunk ${index} of ${plan.job}`, {
    dir,
    need: chunk.frames * frame.bytes,
    basis: frame.basis,
    force: o.force,
  })
}

/** A png job (`render --job`): its PNG frames and audio.wav, in its folder. */
export const preflightPng = async (
  child: Child,
  job: Job,
  dir: string,
  o: { sequential?: unknown; force?: boolean },
) => {
  const { width, height, fps, from, to } = job.output
  const input: Input = job.delivery.bits === 16 ? 'rgba64' : 'rgba'
  const times = frameTimes(fps, from, to)
  const frame = await frameEstimate('png', {
    input,
    width,
    height,
    times,
    render: sampler(child, input, o.sequential),
  })
  const need = times.length * frame.bytes + handoffAudioBytes(to - from, job.delivery.stems)
  return checkDisk(`job ${job.name}`, { dir, need, basis: frame.basis, force: o.force })
}

/**
 * `deliver`: every output before the first renders, with no host open yet: a video by its rate
 * (finalFileBytes), a png job's frames at the raw ceiling. An hdr10 output also renders through
 * one lossless chunk beside its file (P010 for an mp4, rgb10 for ProRes), removed once encoded:
 * the outputs go one at a time, so the largest such chunk counts once, at the raw ceiling.
 */
export const preflightBatch = (jobs: readonly Job[], dir: string, o: { force?: boolean }) => {
  let need = 0
  let chunk = 0
  for (const {
    output: { width, height, fps, from, to },
    delivery,
    range,
  } of jobs) {
    const frames = frameTimes(fps, from, to).length
    if (delivery.format === 'png') {
      const input: Input = delivery.bits === 16 ? 'rgba64' : 'rgba'
      need +=
        frames * frameBytes(input, width, height) + handoffAudioBytes(to - from, delivery.stems)
    } else need += finalFileBytes(delivery, { width, height, fps, seconds: to - from })
    if (range === 'hdr10') {
      const input = delivery.format === 'mp4' ? 'p010' : 'rgb10'
      chunk = Math.max(chunk, frames * frameBytes(input, width, height))
    }
  }
  const ceiling = chunk > 0 || jobs.some((j) => j.delivery.format === 'png')
  return checkDisk(`deliver (${jobs.length} outputs)`, {
    dir,
    need: need + chunk,
    basis: ceiling ? 'ceiling' : 'bitrate',
    force: o.force,
  })
}
