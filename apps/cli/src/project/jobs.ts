import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { frameTimes, type Json, type Manifest } from '@shaderera/core'
import { checkManifest, paramDefaults, withVariant } from '@shaderera/core/host'
import { shadereraVersion } from '../deliver/environment.ts'
import { openBrowserChild } from '../node/browser.ts'
import { buildNode } from '../node/build.ts'
import { type Child, openChild } from '../node/child.ts'
import { type HostName, hostOf } from '../node/host-of.ts'
import type { Project } from '../node/project.ts'
import { installedPackages, type Packages, packageChanges } from './dependencies.ts'
import { type By, fileAt, materialize, readRevision, save } from './revisions.ts'

/**
 * A render job: everything an export needs, frozen. It names a saved revision of the source
 * (`versions/`), the variant, the complete effective params, the seed, the output window and the
 * delivery settings, and records the installed packages the source and its DOM import, by
 * content. It names the host it renders in; that host renders it from the revision's frozen copy
 * (entry and DOM), and refuses to when those packages or the Shaderera version changed. It holds
 * execution inputs, never the film.
 *
 * `id` is the hash of all of that; `name` is the file it is saved as and `label` is for people.
 * A name never changes meaning: making a job under a name that holds different inputs is refused
 * unless the replacement is explicit.
 */
export type Job = {
  shaderera: 'job/3'
  id: string
  name: string
  label?: string
  created: string
  by: By
  revision: string
  /** The host it renders in: the manifest's, or the one asked for when the job was made. */
  host: HostName
  variant?: string
  params: { [key: string]: Json }
  seed: number
  /** Exports use the source's own camera; an inspection camera never reaches a job. */
  camera: 'authored'
  output: { width: number; height: number; fps: number; from: number; to: number }
  delivery: Delivery
  inputs: {
    /** Files that are not code: fonts, images, models, audio (path → sha256). */
    assets: { [path: string]: string }
    /** sha256 of the dependency lock file the revision carries, if any. */
    lock?: string
    /** The installed packages the source executes in Node: `name@version` → sha256 of its files. */
    packages: Packages
    shaderera: string
  }
}

export type Delivery = {
  /**
   * `mp4`: H.264 for review and SDR delivery; `prores-hq` / `prores-4444`: ProRes 422 HQ, or
   * 4444 with alpha, in a mov with 48 kHz 24-bit PCM (an agency or finishing handoff);
   * `png`: an RGBA PNG sequence plus audio for finishing.
   */
  format: 'mp4' | 'png' | 'prores-hq' | 'prores-4444'
  /** `review`: crf 18, preset medium; `master`: crf 12, preset slow. */
  quality: 'review' | 'master'
  /** SDR, BT.709 primaries, transfer and matrix, limited range: the tested conversion. */
  color: 'sdr-bt709'
  /** mp4: a constant bitrate, such as `15M`. */
  bitrate?: string
  /** mp4: a ceiling on the crf's bitrate, such as `10M`. */
  maxrate?: string
  /** mp4: `false` writes no edit list, the audio trimmed by the AAC priming. */
  editList?: false
  /** One WAV per clip group beside the mix. */
  stems?: true
  /** png: 16 bits a channel instead of 8. */
  bits?: 16
}

export const FORMATS: readonly Delivery['format'][] = ['mp4', 'png', 'prores-hq', 'prores-4444']

/**
 * A delivery from flags: `--format` (or `--png`), `--master`, `--bitrate`, `--maxrate`,
 * `--no-edit-list`, `--stems` and `--bits 16`; only what was given, so a job's id stays the same
 * for the same choices.
 */
export const deliveryOf = (v: { [flag: string]: unknown }): Partial<Delivery> => {
  const format = v.png === true ? 'png' : v.format === undefined ? 'mp4' : v.format
  if (!FORMATS.includes(format as Delivery['format']))
    throw new Error(`--format is ${FORMATS.join(', ')}, not ${String(format)}.`)
  const bits = v.bits === undefined ? undefined : Number(v.bits)
  if (bits !== undefined && !(bits === 16 && format === 'png'))
    throw new Error('--bits 16 is for a png delivery (8 is the default).')
  return {
    format: format as Delivery['format'],
    quality: v.master === true ? 'master' : 'review',
    ...(typeof v.bitrate === 'string' ? { bitrate: v.bitrate } : {}),
    ...(typeof v.maxrate === 'string' ? { maxrate: v.maxrate } : {}),
    ...(v['no-edit-list'] === true ? { editList: false as const } : {}),
    ...(v.stems === true ? { stems: true as const } : {}),
    ...(bits === 16 ? { bits: 16 as const } : {}),
  }
}

/** The flags deliveryOf reads. */
export const DELIVERY_FLAGS = {
  format: { type: 'string' as const },
  png: { type: 'boolean' as const },
  master: { type: 'boolean' as const },
  bitrate: { type: 'string' as const },
  maxrate: { type: 'string' as const },
  'no-edit-list': { type: 'boolean' as const },
  stems: { type: 'boolean' as const },
  bits: { type: 'string' as const },
}

/** Making a job under a name that already holds different inputs. */
export class JobExists extends Error {
  readonly existing: Job
  constructor(existing: Job) {
    super(
      `Job ${existing.name} already exists with different inputs (revision ${existing.revision}, ` +
        `${existing.delivery.format} ${existing.delivery.quality}). Choose another name, or replace it explicitly (--replace).`,
    )
    this.existing = existing
  }
}

/** Rendering a job whose installed packages or Shaderera version are not the ones it froze. */
export class ChangedEnvironment extends Error {
  readonly changes: string[]
  constructor(job: Job, changes: string[]) {
    super(
      `Job ${job.name} cannot render as it was frozen: ${changes.join('; ')}. Reinstall what it ` +
        `was made with, or make a new job from revision ${job.revision} to render with what is installed now.`,
    )
    this.changes = changes
  }
}

const DELIVERY: Delivery = { format: 'mp4', quality: 'review', color: 'sdr-bt709' }
const CODE = /\.(ts|tsx|js|mjs|cjs|json|md|txt|css|html)$/i
/** The dependency lock files a project may carry. */
export const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']

const jobsDir = (root: string) => join(root, 'versions', 'jobs')
const pinFile = (root: string, name: string) => join(jobsDir(root), `${name}.host.json`)

/** JSON with object keys sorted, so equal inputs always hash the same. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )

/** The hash of everything a job renders with: not its name, label, author or time. */
export const jobId = (job: Omit<Job, 'id' | 'name' | 'label' | 'created' | 'by'>): string =>
  createHash('sha256')
    .update(
      canonical({
        shaderera: job.shaderera,
        revision: job.revision,
        host: job.host,
        variant: job.variant ?? null,
        params: job.params,
        seed: job.seed,
        camera: job.camera,
        output: job.output,
        delivery: job.delivery,
        inputs: job.inputs,
      }),
    )
    .digest('hex')
    .slice(0, 16)

/** The manifest a revision declares. */
export const manifestAt = (root: string, revision: string): Manifest => {
  const text = fileAt(root, revision, 'shaderera.json')
  if (!text) throw new Error(`Revision ${revision} has no shaderera.json.`)
  return checkManifest(JSON.parse(text.toString('utf8')))
}

/**
 * The params a job renders with: the manifest's defaults, then the variant's, then the ones given.
 * A name the schema does not declare is refused, so a typo never renders silently.
 */
export const effectiveParams = (
  manifest: Manifest,
  variantParams: { readonly [key: string]: Json },
  given: { readonly [key: string]: Json } = {},
): { [key: string]: Json } => {
  const declared = Object.keys(
    ((manifest.params as { properties?: object } | undefined)?.properties ?? {}) as object,
  )
  const unknown = Object.keys(given).filter((k) => !declared.includes(k))
  if (unknown.length > 0) throw new Error(`Unknown params: ${unknown.join(', ')}.`)
  return { ...paramDefaults(manifest), ...variantParams, ...given }
}

/**
 * Builds a revision's frozen copy for Node and finds the installed packages it executes: what
 * the build imports, with what they depend on, and `webgpu` when installed (the Node host loads it
 * for a GPU source).
 */
const frozenBuild = async (root: string, revision: string, variant: string | undefined) => {
  const dir = materialize(root, revision)
  const { manifest } = withVariant(manifestAt(root, revision), variant)
  const project: Project = { root: dir, manifest }
  const built = await buildNode(project)
  const { packages, missing } = installedPackages(dir, built.packages, ['webgpu'])
  if (missing.length > 0)
    throw new Error(
      `Revision ${revision} imports ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not installed.`,
    )
  return { project, entryFile: built.entryFile, packages }
}

/**
 * Freezes a job: saves the working tree as a revision unless one is named, resolves the variant
 * and params against that revision's manifest, records the packages it executes, and writes
 * `versions/jobs/<name>.json`. The same inputs under the same name return the job already there;
 * different inputs under a taken name throw JobExists unless `replace` is set.
 */
export const createJob = async (
  root: string,
  o: {
    by: By
    revision?: string
    variant?: string
    params?: { [key: string]: Json }
    name?: string
    label?: string
    /** Overrides the manifest's host (`--host`). */
    host?: unknown
    from?: number
    to?: number
    delivery?: Partial<Delivery>
    replace?: boolean
  },
): Promise<Job> => {
  if (o.name !== undefined && !/^[\w.-]+$/.test(o.name))
    throw new Error(`A job name is letters, digits, . _ -: ${o.name}`)
  const revision = o.revision ?? save(root, { by: o.by, label: o.label }).id
  const declared = manifestAt(root, revision)
  const { manifest, params: variantParams } = withVariant(declared, o.variant)
  const params = effectiveParams(manifest, variantParams, o.params)
  const seed = manifest.seed ?? 0
  const from = o.from ?? 0
  const to = o.to ?? manifest.duration
  if (!(from >= 0 && to > from && to <= manifest.duration + 1e-9))
    throw new Error(`The window ${from}–${to} s is outside 0–${manifest.duration} s.`)
  if (frameTimes(manifest.fps, from, to).length === 0)
    throw new Error(`The window ${from}–${to} s holds no frame at ${manifest.fps} fps.`)
  const files = readRevision(root, revision).files
  const lock = LOCKS.find((l) => files[l])
  const { packages } = await frozenBuild(root, revision, o.variant)
  const frozen = {
    shaderera: 'job/3' as const,
    revision,
    host: hostOf(manifest, o.host),
    ...(o.variant ? { variant: o.variant } : {}),
    params,
    seed,
    camera: 'authored' as const,
    output: { width: manifest.width, height: manifest.height, fps: manifest.fps, from, to },
    delivery: { ...DELIVERY, ...o.delivery },
    inputs: {
      assets: Object.fromEntries(Object.entries(files).filter(([p]) => !CODE.test(p))),
      ...(lock ? { lock: files[lock] } : {}),
      packages,
      shaderera: shadereraVersion(),
    },
  }
  const id = jobId(frozen)
  const { shaderera, ...rest } = frozen
  const job: Job = {
    shaderera,
    id,
    // A variant's name may hold what a file name cannot (`16:9`, a space).
    name:
      o.name ??
      `${(o.variant ?? 'main').replace(/[^\w.-]/g, '_')}-${revision.slice(0, 8)}-${id.slice(0, 6)}`,
    ...(o.label ? { label: o.label } : {}),
    created: new Date().toISOString(),
    by: o.by,
    ...rest,
  }
  mkdirSync(jobsDir(root), { recursive: true })
  const file = join(jobsDir(root), `${job.name}.json`)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(job, null, 1)}\n`)
  if (o.replace) {
    let was: unknown
    try {
      was = JSON.parse(readFileSync(file, 'utf8')).id
    } catch {
      was = undefined
    }
    renameSync(tmp, file)
    // Another job under the name: its first render pins its own host.
    if (was !== job.id) rmSync(pinFile(root, job.name), { force: true })
    return job
  }
  try {
    // A hard link fails when the name is taken, so two writers never both claim it.
    linkSync(tmp, file)
    return job
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const existing = readJob(root, job.name)
    if (existing.id === job.id) return existing
    throw new JobExists(existing)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** A job by name (from `versions/jobs/`) or by file path, checked against its own id. */
export const readJob = (root: string, nameOrFile: string): Job => {
  const named = join(jobsDir(root), `${nameOrFile}.json`)
  const file = /^[\w.-]+$/.test(nameOrFile) && existsSync(named) ? named : nameOrFile
  if (!existsSync(file)) throw new Error(`No job ${nameOrFile}.`)
  const job = JSON.parse(readFileSync(file, 'utf8')) as Job
  if (job.shaderera !== 'job/3')
    throw new Error(
      `${file} is not a render job of this Shaderera (shaderera: job/3); recreate this job with shaderera job.`,
    )
  const o = job.output
  const wellFormed =
    typeof job.name === 'string' &&
    /^[\w.-]+$/.test(job.name) &&
    /^[0-9a-f]{16}$/.test(job.revision) &&
    (job.host === 'node' || job.host === 'browser') &&
    job.params !== null &&
    typeof job.params === 'object' &&
    Number.isFinite(job.seed) &&
    [o?.width, o?.height].every((n) => Number.isInteger(n) && n > 0) &&
    Number.isFinite(o?.fps) &&
    o.fps > 0 &&
    Number.isFinite(o?.from) &&
    Number.isFinite(o?.to) &&
    FORMATS.includes(job.delivery?.format) &&
    ['review', 'master'].includes(job.delivery?.quality) &&
    job.delivery?.color === 'sdr-bt709' &&
    typeof job.inputs?.packages === 'object'
  if (!wellFormed) throw new Error(`${file} is not a well-formed render job.`)
  if (jobId(job) !== job.id)
    throw new Error(`${file} does not match its id ${job.id}: the job was changed by hand.`)
  if (basename(file) === `${job.name}.json` || !file.startsWith(jobsDir(root))) return job
  throw new Error(`${file} holds job ${job.name}: a job's file is named after it.`)
}

export const listJobs = (root: string): Job[] =>
  existsSync(jobsDir(root))
    ? readdirSync(jobsDir(root))
        .filter((f) => f.endsWith('.json') && !f.endsWith('.host.json'))
        .map((f) => readJob(root, join(jobsDir(root), f)))
    : []

/**
 * Checks that a job can render as it was frozen: builds its revision's frozen copy and compares
 * the installed packages it executes, and the Shaderera version, with the ones the job recorded.
 * Throws ChangedEnvironment when they differ. Every host calls this before rendering a job.
 */
export const verifyJob = async (root: string, job: Job) => {
  const built = await frozenBuild(root, job.revision, job.variant)
  const changes = packageChanges(job.inputs.packages, built.packages)
  if (job.inputs.shaderera !== shadereraVersion())
    changes.push(
      `it was made with Shaderera ${job.inputs.shaderera} and this is ${shadereraVersion()}`,
    )
  if (changes.length > 0) throw new ChangedEnvironment(job, changes)
  return built
}

/**
 * Opens a built revision in a host: Node opens the frozen copy's build; the browser host serves
 * the live project's runner and opens the revision's frozen entry and DOM from there.
 */
const openFrozen = (
  root: string,
  built: Awaited<ReturnType<typeof frozenBuild>>,
  host: HostName,
  r: { revision: string; variant?: string; params: { [key: string]: Json }; seed: number },
  o: { trusted?: boolean; timeoutMs?: number },
): Promise<Child> =>
  host === 'browser'
    ? openBrowserChild(
        { root, manifest: built.project.manifest },
        {
          revision: r.revision,
          params: r.params,
          ...(r.variant ? { variant: r.variant } : {}),
          ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        },
      )
    : openChild(built.project, { entryFile: built.entryFile, params: r.params, seed: r.seed, ...o })

/**
 * Opens a job in its host: checks it (verifyJob), then opens the revision's frozen copy with the
 * job's manifest (its variant), params and seed. The returned project's root is that copy, so
 * audio and assets resolve inside it.
 *
 * The first render pins the host it ran on (`versions/jobs/<name>.host.json`: Node version, Chrome
 * build and flags, GPU adapter); a later render on another one is refused with ChangedEnvironment,
 * since exact pixels are promised only within one host on one machine.
 */
export const openJob = async (
  root: string,
  job: Job,
  o: { trusted?: boolean; timeoutMs?: number } = {},
): Promise<{ project: Project; child: Child; more: () => Promise<Child> }> => {
  const built = await verifyJob(root, job)
  const child = await openFrozen(root, built, job.host, job, o)
  try {
    const now = await child.identity()
    const file = pinFile(root, job.name)
    if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(now, null, 1)}\n`)
    else {
      const was = JSON.parse(readFileSync(file, 'utf8')) as { [key: string]: unknown }
      const changes = Object.keys({ ...was, ...now })
        .filter((k) => canonical(was[k]) !== canonical((now as { [key: string]: unknown })[k]))
        .map(
          (k) =>
            `its ${k} was ${canonical(was[k])} and is ${canonical((now as { [key: string]: unknown })[k])}`,
        )
      if (changes.length > 0)
        throw new ChangedEnvironment(job, [
          `it was first rendered on another host (${file}): ${changes.join('; ')}`,
        ])
    }
  } catch (error) {
    await child.close()
    throw error
  }
  // Another host on the same frozen build, for a parallel export.
  return { project: built.project, child, more: () => openFrozen(root, built, job.host, job, o) }
}

/** What a delivery asks of a video export (exportVideo's VideoOptions). */
export const videoOptionsOf = (d: Partial<Delivery>) => ({
  codec: d.format === 'prores-hq' || d.format === 'prores-4444' ? d.format : ('h264' as const),
  ...(d.bitrate ? { bitrate: d.bitrate } : {}),
  ...(d.maxrate ? { maxrate: d.maxrate } : {}),
  ...(d.editList === false ? { editList: false } : {}),
  ...(d.stems ? { stems: true } : {}),
})
