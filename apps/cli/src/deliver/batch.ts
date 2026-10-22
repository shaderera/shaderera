import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { frameTimes } from '@shaderera/core'
import type { Loudness, Probe } from '../cli/ffmpeg.ts'
import { defaultWorkers, exportVideo, extensionOf, hostBudget } from '../cli/render.ts'
import type { Child } from '../node/child.ts'
import type { Project } from '../node/project.ts'
import {
  createJob,
  type Delivery,
  type Job,
  manifestAt,
  openJob,
  safeName,
  videoOptionsOf,
} from '../project/jobs.ts'
import {
  gate,
  outputRequirements,
  type Requirements,
  readRequirements,
} from '../project/requirements.ts'
import { save, slash } from '../project/revisions.ts'
import { review } from '../review/review.ts'
import { exportFinishing } from './finishing.ts'
import { checkPlacement } from './placement.ts'

export type BatchOutput = {
  job: string
  variant?: string
  locale?: string
  format: Delivery['format']
  quality: Delivery['quality']
  /** The mp4 or the finishing folder, relative to the batch folder. */
  file?: string
  bytes?: number
  width: number
  height: number
  duration: number
  frames?: number
  seconds?: number
  /** The output's audio, measured (EBU R128); null without audio. */
  loudness?: Loudness | null
  /** A video file as ffprobe and its boxes report it (codec, bitrate, colour tags, edit list). */
  probe?: Probe
  contactSheet?: string
  checks: {
    id: string
    title: string
    status: 'pass' | 'fail' | 'unknown' | 'info'
    measured?: string
    detail?: string
    at?: number[]
    required?: boolean
  }[]
  /** `fail` when a check the requirements need did not pass (unknown is not a pass). */
  status: 'pass' | 'fail'
  error?: string
}

export type BatchIndex = {
  shaderera: 'deliveries/1'
  batch: string
  created: string
  revision: string
  outputs: BatchOutput[]
}

const dirSize = (path: string): number => {
  const s = statSync(path)
  if (!s.isDirectory()) return s.size
  let n = 0
  for (const e of readdirSync(path)) n += dirSize(join(path, e))
  return n
}

/**
 * The jobs a batch renders: given ones, or one per variant × locale from the project as it is
 * now, saved once as a revision. A locale sets the `locale` param, which the manifest must
 * declare (and list, when it has an enum); otherwise the locale is refused before anything runs.
 */
export const batchJobs = async (
  root: string,
  o: {
    batch: string
    jobs?: readonly Job[]
    variants?: readonly string[]
    locales?: readonly string[]
    delivery: Partial<Delivery>
    /** Re-run a named batch: its job names then take the new inputs (JobExists otherwise). */
    replace?: boolean
  },
): Promise<Job[]> => {
  if (o.jobs && o.jobs.length > 0) return [...o.jobs]
  const revision = save(root, { by: 'cli', label: `deliver ${o.batch}` }).id
  const manifest = manifestAt(root, revision)
  const locales = o.locales?.length ? o.locales : [undefined]
  if (o.locales?.length) {
    const prop = (manifest.params as { properties?: { locale?: { enum?: string[] } } } | undefined)
      ?.properties?.locale
    if (!prop)
      throw new Error(
        `Locales need a "locale" param in shaderera.json; this project declares none (${o.locales.join(', ')} refused).`,
      )
    const unknown = o.locales.filter((l) => prop.enum && !prop.enum.includes(l))
    if (unknown.length > 0)
      throw new Error(
        `Unknown locale ${unknown.join(', ')}: the locale param allows ${prop.enum?.join(', ')}.`,
      )
  }
  // `main` names the manifest's own format, so a batch can deliver it beside its variants.
  const variants = o.variants?.length
    ? o.variants.map((v) => (v === 'main' ? undefined : v))
    : [undefined]
  const unknownVariants = variants.filter((v) => v && !manifest.variants?.[v])
  if (unknownVariants.length > 0) throw new Error(`Unknown variant ${unknownVariants.join(', ')}.`)
  const jobs: Job[] = []
  for (const variant of variants)
    for (const locale of locales)
      jobs.push(
        await createJob(root, {
          by: 'cli',
          revision,
          variant,
          params: locale ? { locale } : undefined,
          // A variant may be named what a job name cannot hold (16:9).
          name: [o.batch, safeName(variant ?? 'main'), locale].filter(Boolean).join('-'),
          delivery: o.delivery,
          replace: o.replace,
        }),
      )
  return jobs
}

/**
 * How many hosts each of a batch's jobs renders on, out of one budget: one each while the budget
 * lasts, then the rest go round the jobs that want more (`wants`: defaultWorkers, 1 for a
 * sequential source or a png handoff). A job given 0 waits for a host to come free.
 */
export const shareHosts = (wants: readonly number[], budget: number): number[] => {
  const got = wants.map(() => 0)
  let left = Math.max(1, Math.floor(budget))
  for (let more = true; more && left > 0; ) {
    more = false
    for (const [i, want] of wants.entries())
      if (left > 0 && (got[i] as number) < want) {
        got[i] = (got[i] as number) + 1
        left--
        more = true
      }
  }
  return got
}

type Opened = { project: Project; child: Child; more?: () => Promise<Child> }

/** What deliverBatch passes on to each output. */
type OutputOptions = {
  dir: string
  base: Requirements
  audio?: boolean
  loudness?: number
  open: (job: Job) => Promise<Opened>
  onFrame?: (i: number, n: number) => void
}

/**
 * Renders one output of a batch into `<dir>/<job>/` on `workers` hosts and reviews it on the first
 * against output-specific requirements. A failure is recorded in the output, never thrown.
 */
const deliverOutput = async (job: Job, workers: number, o: OutputOptions): Promise<BatchOutput> => {
  const { dir } = o
  const { width, height, fps, from, to } = job.output
  const out: BatchOutput = {
    job: job.name,
    ...(job.variant ? { variant: job.variant } : {}),
    ...(typeof job.params.locale === 'string' ? { locale: job.params.locale } : {}),
    format: job.delivery.format,
    quality: job.delivery.quality,
    width,
    height,
    duration: to - from,
    checks: [],
    status: 'fail',
  }
  const jobDir = join(dir, job.name)
  const requirements: Requirements = {
    ...outputRequirements(o.base, {
      variant: job.variant,
      width,
      height,
      fps,
      duration: to - from,
    }),
    format: { width, height, fps, duration: to - from },
  }
  let opened: Opened | undefined
  try {
    opened = await o.open(job)
    const { project, child, more } = opened
    // A textless variant: no copy is asked of it (outputRequirements).
    if (project.manifest.textless) requirements.copy = []
    let report: Awaited<ReturnType<typeof review>>
    if (job.delivery.format === 'png') {
      const done = await exportFinishing(project, child, job, {
        dir: jobDir,
        requirements,
        audio: o.audio,
        loudness: o.loudness,
        ...(o.onFrame ? { onFrame: o.onFrame } : {}),
        ...(job.delivery.bits ? { bits: job.delivery.bits } : {}),
        ...(job.delivery.stems ? { stems: true } : {}),
      })
      report = done.review
      if (requirements.placement)
        report.checks.push({
          id: 'placement',
          title: 'placement',
          status: 'unknown',
          detail: 'a png handoff is a folder of frames, not a file a placement takes',
        })
      Object.assign(out, {
        file: job.name,
        frames: done.record.frameCount,
        seconds: done.seconds,
        loudness: done.record.audio?.loudness ?? null,
      })
    } else {
      const video0 = videoOptionsOf(job.delivery)
      const file = join(jobDir, `${job.name}${extensionOf(video0.codec)}`)
      const video = await exportVideo(project, child, {
        ...video0,
        from,
        to,
        out: file,
        quality: job.delivery.quality,
        revision: job.revision,
        audio: o.audio,
        loudness: o.loudness,
        // Its share of the batch's hosts (one for a sequential source), closed by exportVideo.
        workers,
        ...(more ? { more } : {}),
        ...(o.onFrame ? { onFrame: o.onFrame } : {}),
      })
      report = await review({ project, child, outDir: join(jobDir, 'review'), requirements })
      if (requirements.placement) {
        const p = checkPlacement(requirements.placement, file, video.probe, video.loudness)
        report.checks.push({
          id: 'placement',
          title: `placement${requirements.placement.name ? ` ${requirements.placement.name}` : ''}`,
          status: p.failures.length ? 'fail' : 'pass',
          measured: p.measured,
          ...(p.failures.length ? { detail: p.failures.join('; ') } : {}),
        })
      }
      Object.assign(out, {
        file: slash(relative(dir, file)),
        frames: video.frames,
        seconds: video.seconds,
        loudness: video.loudness,
        probe: video.probe,
      })
    }
    out.bytes = dirSize(join(dir, out.file as string))
    out.contactSheet = slash(relative(dir, report.contactSheet))
    out.checks = gate(
      report.checks.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        ...(c.measured ? { measured: c.measured } : {}),
        ...(c.detail ? { detail: c.detail } : {}),
        ...(c.at?.length ? { at: c.at } : {}),
      })),
      requirements,
    )
    out.status = out.checks.some((c) => c.required && c.status !== 'pass') ? 'fail' : 'pass'
  } catch (error) {
    out.error = (error as Error).message
  } finally {
    await opened?.child.close()
  }
  return out
}

/**
 * Renders a batch into `out/deliveries/<batch>/<job>/` and reviews each output on its own child
 * against output-specific requirements: the output's own size, rate and length as the format,
 * and only what requirements.json declares besides (no default safe area: decision 0011).
 * The outputs render at once on one budget of hosts (shareHosts), each file the same as its job
 * rendered alone. Writes `index.json` and `index.md`, in the jobs' order. One output's failure is
 * recorded and the rest still render.
 */
export const deliverBatch = async (
  root: string,
  jobs: readonly Job[],
  o: {
    batch: string
    /** `false`: no audio in any output (a silent DOOH placement, say). */
    audio?: boolean
    /** A loudness to bring every output's mix to, in LUFS integrated (openMix). */
    loudness?: number
    trusted?: boolean
    timeoutMs?: number
    /** How many hosts the whole batch renders on at once: hostBudget() by default. */
    workers?: number
    /** An output starts, on `hosts` hosts. */
    onOutput?: (i: number, n: number, job: Job, hosts: number) => void
    /** Output `i` rendered frame `frame` of its `frames`. */
    onFrame?: (i: number, frame: number, frames: number) => void
    /**
     * Opens a job's host, and `more` opens another for a parallel export: openJob by default;
     * tests give an in-memory Child.
     */
    open?: (job: Job) => Promise<Opened>
  },
): Promise<{ dir: string; index: BatchIndex }> => {
  const open =
    o.open ?? ((job: Job) => openJob(root, job, { trusted: o.trusted, timeoutMs: o.timeoutMs }))
  const dir = join(root, 'out', 'deliveries', o.batch)
  mkdirSync(dir, { recursive: true })
  const base = readRequirements(root)
  const wants = jobs.map((job) =>
    job.delivery.format === 'png'
      ? 1
      : defaultWorkers(
          manifestAt(root, job.revision),
          frameTimes(job.output.fps, job.output.from, job.output.to).length,
        ),
  )
  const shares = shareHosts(wants, o.workers ?? hostBudget())
  // As many outputs at once as got hosts; one that got none waits for the first to finish.
  const lanes = Math.max(1, shares.filter((n) => n > 0).length)
  const outputs: BatchOutput[] = []
  let next = 0
  const lane = async () => {
    for (let i = next++; i < jobs.length; i = next++) {
      const job = jobs[i] as Job
      const hosts = Math.max(1, shares[i] as number)
      o.onOutput?.(i, jobs.length, job, hosts)
      outputs[i] = await deliverOutput(job, hosts, {
        dir,
        base,
        audio: o.audio,
        loudness: o.loudness,
        open,
        ...(o.onFrame ? { onFrame: (f: number, n: number) => o.onFrame?.(i, f, n) } : {}),
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, lane))
  const index: BatchIndex = {
    shaderera: 'deliveries/1',
    batch: o.batch,
    created: new Date().toISOString(),
    revision: jobs[0]?.revision ?? '',
    outputs,
  }
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 1)}\n`)
  writeFileSync(join(dir, 'index.md'), indexMarkdown(index))
  return { dir, index }
}

/** Bytes as kB or MB. */
export const bytes = (n: number) =>
  n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(2)} MB`

const count = (o: BatchOutput, s: 'pass' | 'fail' | 'unknown') =>
  o.checks.filter((c) => c.status === s).length

/** The batch as a table a person reads: one row per output, then each failing check. */
export const indexMarkdown = (index: BatchIndex): string => {
  const rows = index.outputs.map((o) =>
    [
      o.status === 'pass' ? 'pass' : 'FAIL',
      o.job,
      o.file ? `[${o.file}](${o.file})` : '—',
      `${o.width}×${o.height}`,
      `${o.duration} s`,
      o.bytes === undefined ? '—' : bytes(o.bytes),
      `${count(o, 'pass')} / ${count(o, 'fail')} / ${count(o, 'unknown')}`,
      o.contactSheet ? `[sheet](${o.contactSheet})` : '—',
    ].join(' | '),
  )
  const failures = index.outputs.flatMap((o) => [
    ...(o.error ? [`- ${o.job}: ${o.error}`] : []),
    ...o.checks
      .filter((c) => c.status === 'fail' || (c.required && c.status !== 'pass'))
      .map((c) => `- ${o.job}: ${c.title}${c.measured ? ` — ${c.measured}` : ''}`),
  ])
  return [
    `# Deliveries: ${index.batch}`,
    '',
    `Revision ${index.revision}, ${index.created}. Checks marked info were measured with nothing in requirements.json to judge them against.`,
    '',
    '| status | job | file | size | length | bytes | checks pass / fail / unknown | contact sheet |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r} |`),
    '',
    ...(failures.length ? ['## Failing', '', ...failures, ''] : []),
  ].join('\n')
}
