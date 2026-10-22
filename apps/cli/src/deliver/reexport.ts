// Re-exporting part of a delivery (#290): the sound onto a delivered file's own video packets,
// and the frames of a plan's chunks into another delivery of the same job. Nothing here renders a
// frame the file or the chunks already hold.
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { frameTimes } from '@shaderera/core'
import type { Codec, Probe } from '../cli/ffmpeg.ts'
import type { EncodeAudio } from '../cli/mix.ts'
import type { Child } from '../node/child.ts'
import { type Job, readJob } from '../project/jobs.ts'
import type { Plan } from './chunks.ts'
import { inputOf } from './chunks.ts'

const json = (v: unknown) => JSON.stringify(v ?? null)

/** What two jobs (or probes) say differently about `keys`, one phrase each. */
const differences = <T>(a: T, b: T, keys: readonly (keyof T & string)[]): string[] =>
  keys.flatMap((k) =>
    isDeepStrictEqual(a[k] ?? null, b[k] ?? null) ? [] : [`${k} ${json(a[k])}, not ${json(b[k])}`],
  )

/** A delivery without its stems: what a delivered file's picture was encoded with. */
const pictureDelivery = ({ stems: _, ...d }: Job['delivery']) => d

/**
 * What job `was` and `job` say differently about the picture, besides the revision and params
 * (which the frames themselves are checked for: sameFrames): the host, variant, seed, camera,
 * window and the delivery's picture settings (format, quality, rates, edit list).
 */
export const pictureDifferences = (was: Job, job: Job): string[] => [
  ...differences(was, job, ['host', 'variant', 'seed', 'camera', 'output']),
  ...(isDeepStrictEqual(pictureDelivery(was.delivery), pictureDelivery(job.delivery))
    ? []
    : [`delivery ${json(was.delivery)}, not ${json(job.delivery)}`]),
]

/**
 * The job that made a delivered file of revision `revision`, for re-exporting `job`'s sound onto
 * it: one of `jobs` of that revision with `job`'s picture settings, `job` itself first, then one
 * with its params. Throws when there is none, saying why.
 */
export const jobOfFile = (jobs: readonly Job[], job: Job, file: string, revision: string): Job => {
  const ofRevision = jobs.filter((j) => j.revision === revision)
  const fits = ofRevision.filter((j) => pictureDifferences(j, job).length === 0)
  const was =
    fits.find((j) => j.id === job.id) ??
    fits.find((j) => isDeepStrictEqual(j.params, job.params)) ??
    fits[0]
  if (was) return was
  const other = ofRevision[0]
  throw new Error(
    other
      ? `${file} is of job ${other.name}, whose picture is not job ${job.name}'s (${pictureDifferences(other, job).join('; ')}): render job ${job.name} instead.`
      : `${file} is of revision ${revision}, and no job of that revision is in versions/jobs: its picture cannot be checked. Render job ${job.name} instead.`,
  )
}

/** Frames of a window to compare: the first, the last, and about one every 10 s between. */
export const samplesOf = (count: number, fps: number): number[] => {
  const picked = new Set([0, count - 1])
  const spread = Math.ceil(count / (10 * fps))
  for (let k = 0; k < spread; k++) picked.add(Math.floor(((k + 0.5) * count) / spread))
  return [...picked].filter((i) => i >= 0).sort((x, y) => x - y)
}

/**
 * Renders a sample of the window's frames (samplesOf) in both jobs' hosts and compares them byte
 * for byte, in the format `job`'s hosts hand frames over. Returns the times of the frames that
 * differ.
 */
export const sameFrames = async (was: Child, now: Child, job: Job): Promise<number[]> => {
  const { fps, from, to } = job.output
  const times = frameTimes(fps, from, to)
  const input = inputOf(job, now)
  const differ: number[] = []
  for (const i of samplesOf(times.length, fps)) {
    const t = times[i] as number
    const [a, b] = await Promise.all([was.render(t, 'final', input), now.render(t, 'final', input)])
    const bytes = (p: Uint8Array | Uint8ClampedArray) =>
      Buffer.from(p.buffer, p.byteOffset, p.byteLength)
    if (!bytes(a.pixels).equals(bytes(b.pixels))) differ.push(t)
  }
  return differ
}

const s = (n: number) => String(Number(n.toFixed(6)))

/**
 * ffmpeg's arguments for a file with `video`'s video packets as they are (`-c:v copy`) and a new
 * mix (Mix.encode, its clips from input 1), or no sound: AAC 192k for an mp4, 48 kHz 24-bit PCM for
 * a mov, the container's flags as ffmpegArgs writes them, tagged with the revision of the sound.
 */
export const remuxArgs = (o: {
  video: string
  out: string
  container: string
  codec: Codec
  audio: EncodeAudio | null
  seconds: number
  revision: string
  editList?: boolean
  timecode?: string
}): string[] => {
  const prores = o.codec !== 'h264'
  const args = ['-y', '-loglevel', 'error', '-i', o.video]
  if (o.audio) args.push(...o.audio.inputs, '-filter_complex', o.audio.graph)
  args.push('-map', '0:v', ...(o.audio ? ['-map', '[aout]'] : []), '-c:v', 'copy')
  if (o.audio)
    args.push(
      ...(prores ? ['-c:a', 'pcm_s24le'] : ['-c:a', 'aac', '-b:a', '192k']),
      ...['-ar', '48000', '-ac', '2'],
    )
  if (prores) args.push('-movflags', '+use_metadata_tags', '-fflags', '+bitexact')
  else {
    const flags = o.editList === false ? '+faststart+negative_cts_offsets' : '+faststart'
    args.push('-movflags', `${flags}+use_metadata_tags`)
    if (o.editList === false) args.push('-use_editlist', '0')
  }
  if (o.timecode) args.push('-timecode', o.timecode)
  args.push('-metadata', `shaderera_revision=${o.revision}`)
  args.push('-f', o.container, '-t', s(o.seconds), o.out)
  return args
}

/**
 * What a remux changed of an HDR10 file's signalling (decision 0023): its colour tags, codec tag,
 * chroma site, `mdcv`/`clli` boxes and first-frame SEI, which `-c:v copy` must carry as they are.
 * The light levels are the ones its encode measured over every frame (for a plan's file, the most
 * over its chunks): a file that lost or changed them would declare other light than its frames'.
 * Empty for an SDR file, and when nothing changed.
 */
export const hdr10Changes = (was: Probe, now: Probe): string[] => {
  const a = was.video
  if (!a?.hdr10) return []
  const b = now.video
  const signalling = (v: typeof a | undefined) => ({ color: v?.color, ...v?.hdr10 })
  return differences(signalling(a), signalling(b), [
    'color',
    'codecTag',
    'chroma',
    'mastering',
    'light',
    'sei',
  ])
}

/** Runs ffmpeg with `args`, throwing its own error. */
export const remux = (args: readonly string[]) => {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' })
  if (r.status !== 0)
    throw new Error(`ffmpeg could not remux the sound: ${(r.error?.message ?? r.stderr).trim()}`)
}

/**
 * The job `assemble --plan <dir> [--job name]` encodes: the plan's own, or another delivery of it
 * (`name`), which must be the plan's job in all but its delivery: the same revision, host,
 * variant, params, seed, window and packages. The frames as handed over are checked once its host
 * is open (assembledInput).
 */
export const assembledJob = (root: string, plan: Plan, name?: string): Job => {
  const own = readJob(root, plan.job)
  if (own.id !== plan.jobId)
    throw new Error(
      `Job ${own.name} is not the one this plan was made from (${plan.jobId.slice(0, 8)}).`,
    )
  if (name === undefined) return own
  const job = readJob(root, name)
  if (job.delivery.format === 'png')
    throw new Error(`Job ${job.name} is a png handoff: render it with render --job ${job.name}.`)
  const keys = ['revision', 'host', 'variant', 'params', 'seed', 'camera', 'output', 'inputs']
  const differ = differences(own, job, keys as (keyof Job & string)[])
  if (differ.length > 0)
    throw new Error(
      `Job ${job.name} is not another delivery of job ${own.name}, whose chunks these are: its ${differ.join('; ')}. Render job ${job.name} instead.`,
    )
  return job
}

/** Throws when `job`'s hosts would hand its frames over in another format than the plan's chunks. */
export const assembledInput = (plan: Plan, job: Job, child: Child) => {
  const input = inputOf(job, child)
  if (input !== plan.input)
    throw new Error(
      `Job ${job.name} (${job.delivery.format}) is encoded from frames as ${input}, and the chunks of job ${plan.job} hold them as ${plan.input}: render job ${job.name} instead.`,
    )
}
