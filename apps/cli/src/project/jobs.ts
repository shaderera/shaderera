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
import { frameTimes, type Json, type Manifest, type Range } from '@shaderera/core'
import { checkManifest, paramDefaults, withVariant } from '@shaderera/core/host'
import { QUALITIES, type X264 } from '../cli/ffmpeg.ts'
import { shadereraVersion } from '../deliver/environment.ts'
import { buildNode } from '../node/build.ts'
import type { Child } from '../node/child.ts'
import { type HostName, hostOf } from '../node/host-of.ts'
import { hostOpener, openHosts } from '../node/open-host.ts'
import type { Project } from '../node/project.ts'
import { checkJobBakes, type JobBakes, pinBakes } from './bakes.ts'
import { installedPackages, type Packages, packageChanges } from './dependencies.ts'
import { type By, fileAt, materialize, readRevision, releaseFrozen, save } from './revisions.ts'

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
  /**
   * The light it renders: `hdr10` for a film with `hdr10` in its manifest; absent, SDR (the
   * film's own SDR version is the same job without it). The source reads it as `host.range`.
   */
  range?: Range
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
    /** The bakes the source reads, as stamped when the job was made (decision 0016). */
    bakes?: JobBakes
  }
}

export type Delivery = {
  /**
   * `mp4`: H.264 for review and SDR delivery; `prores-hq` / `prores-4444`: ProRes 422 HQ, or
   * 4444 with alpha, in a mov with 48 kHz 24-bit PCM (an agency or finishing handoff);
   * `png`: an RGBA PNG sequence plus audio for finishing.
   */
  format: 'mp4' | 'png' | 'prores-hq' | 'prores-4444'
  /** x264 `review`: crf 16, preset veryfast; `master`: crf 10, preset veryfast (QUALITIES). */
  quality: 'review' | 'master'
  /**
   * An H.264 master's x264 settings, recorded when the job was made so that it always renders the
   * same file. A master job made by 0.2.1 or earlier has none: slow crf 12 (videoOptionsOf).
   */
  x264?: X264
  /**
   * `sdr-bt709`: SDR, BT.709 primaries, transfer and matrix, limited range (the tested conversion).
   * `hdr10-bt2020-pq`: an hdr10 job's (decision 0023), BT.2020 primaries and matrix, PQ, 10 bits,
   * limited range, with the mastering display and the measured light levels.
   */
  color: 'sdr-bt709' | 'hdr10-bt2020-pq'
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

/**
 * Refuses a delivery an hdr10 render cannot make: HDR10 is an HEVC Main 10 mp4 or a ProRes mov here
 * (decision 0023), encoded by quality. A PQ PNG would need PNG's `cICP` chunk, which Shaderera
 * does not write.
 */
export const checkHdr10Delivery = (d: Partial<Delivery>) => {
  const format = d.format ?? 'mp4'
  if (format === 'png')
    throw new Error(
      'HDR10 is delivered as an mp4 (HEVC Main 10) or a ProRes mov, not png: a png handoff is 8- or 16-bit sRGB (a PQ PNG needs a cICP chunk, which Shaderera does not write).',
    )
  if (d.bitrate !== undefined || d.maxrate !== undefined)
    throw new Error(
      '--bitrate and --maxrate are for H.264: an HDR10 mp4 is encoded by quality (--master or not).',
    )
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
        // Only an HDR job hashes it: an SDR job's id is what it always was.
        ...(job.range === 'hdr10' ? { range: job.range } : {}),
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
  if (unknown.length > 0)
    throw new Error(
      `Unknown params: ${unknown.join(', ')}. ${declared.length > 0 ? `shaderera.json declares ${declared.join(', ')}` : 'shaderera.json declares no params'}.`,
    )
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
 * A variant's name as a file name: it may hold what a file name cannot (`16:9`, a space, a `/`),
 * and `..` would leave the folder.
 */
export const safeName = (name: string) => name.replace(/[^\w.-]|^\.+$/g, '_')

/**
 * A window of the film, `from` (0 by default) to `to` (its duration): each a number of seconds,
 * inside the film and holding a frame; throws naming the one that is not.
 */
export const windowOf = (
  manifest: Pick<Manifest, 'duration' | 'fps'>,
  given: unknown,
  until: unknown,
): { from: number; to: number } => {
  for (const [key, x] of [
    ['from', given],
    ['to', until],
  ] as const)
    if (x !== undefined && !(typeof x === 'number' && Number.isFinite(x)))
      throw new Error(
        `Not a time in seconds: ${key} ${typeof x === 'string' ? JSON.stringify(x) : String(x)}.`,
      )
  const from = (given as number | undefined) ?? 0
  const to = (until as number | undefined) ?? manifest.duration
  if (!(from >= 0 && to > from && to <= manifest.duration + 1e-9))
    throw new Error(`The window ${from}–${to} s is outside 0–${manifest.duration} s.`)
  if (frameTimes(manifest.fps, from, to).length === 0)
    throw new Error(`The window ${from}–${to} s holds no frame at ${manifest.fps} fps.`)
  return { from, to }
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
    /** `hdr10` needs the manifest's hdr10 block; `sdr` is the default. */
    range?: Range
    from?: number
    to?: number
    delivery?: Partial<Delivery>
    replace?: boolean
  },
): Promise<Job> => {
  if (o.name !== undefined && !/^[\w.-]+$/.test(o.name))
    throw new Error(`A job name is letters, digits, . _ -: ${o.name}`)
  // `<name>.host.json` is a job's host pin.
  if (o.name?.endsWith('.host')) throw new Error(`A job name does not end in .host: ${o.name}`)
  const revision = o.revision ?? save(root, { by: o.by, label: o.label }).id
  const declared = manifestAt(root, revision)
  const { manifest, params: variantParams } = withVariant(declared, o.variant)
  const params = effectiveParams(manifest, variantParams, o.params)
  const seed = manifest.seed ?? 0
  if (o.range === 'hdr10' && !manifest.hdr10)
    throw new Error(
      'An hdr10 job needs the hdr10 block in shaderera.json: { mastering: { peak, min, primaries }, dither }.',
    )
  if (o.range === 'hdr10') checkHdr10Delivery(o.delivery ?? {})
  const { from, to } = windowOf(manifest, o.from, o.to)
  const files = readRevision(root, revision).files
  const lock = LOCKS.find((l) => files[l])
  const bakes = pinBakes(root, declared, revision, files)
  // Built only to find the packages: the copy goes unless a render is using it.
  const { packages } = await frozenBuild(root, revision, o.variant).finally(() =>
    releaseFrozen(root, revision),
  )
  const frozen = {
    shaderera: 'job/3' as const,
    revision,
    host: hostOf(manifest, o.host),
    ...(o.variant ? { variant: o.variant } : {}),
    params,
    seed,
    ...(o.range === 'hdr10' ? { range: o.range } : {}),
    camera: 'authored' as const,
    output: { width: manifest.width, height: manifest.height, fps: manifest.fps, from, to },
    delivery: {
      ...DELIVERY,
      ...recordX264(o.delivery ?? {}, o.range),
      ...(o.range === 'hdr10' ? { color: 'hdr10-bt2020-pq' as const } : {}),
    },
    inputs: {
      assets: Object.fromEntries(Object.entries(files).filter(([p]) => !CODE.test(p))),
      ...(lock ? { lock: files[lock] } : {}),
      packages,
      shaderera: shadereraVersion(),
      ...(Object.keys(bakes).length > 0 ? { bakes } : {}),
    },
  }
  const id = jobId(frozen)
  const { shaderera, ...rest } = frozen
  const job: Job = {
    shaderera,
    id,
    name: o.name ?? `${safeName(o.variant ?? 'main')}-${revision.slice(0, 8)}-${id.slice(0, 6)}`,
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
    (job.range === undefined || job.range === 'sdr' || job.range === 'hdr10') &&
    [o?.width, o?.height].every((n) => Number.isInteger(n) && n > 0) &&
    Number.isFinite(o?.fps) &&
    o.fps > 0 &&
    Number.isFinite(o?.from) &&
    Number.isFinite(o?.to) &&
    FORMATS.includes(job.delivery?.format) &&
    ['review', 'master'].includes(job.delivery?.quality) &&
    job.delivery?.color === (job.range === 'hdr10' ? 'hdr10-bt2020-pq' : 'sdr-bt709') &&
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
  return { ...built, bakes: checkJobBakes(job) }
}

/**
 * An opener for a built revision in a host (hostOpener): Node opens the frozen copy's build; the
 * browser host serves the live project's runner and opens the revision's frozen entry and DOM from
 * there. Both get the job's params and seed.
 */
const frozenOpener = (
  root: string,
  built: Awaited<ReturnType<typeof verifyJob>>,
  job: Job,
  o: { trusted?: boolean; timeoutMs?: number; range?: Range },
): Promise<() => Promise<Child>> => {
  const range = o.range ?? job.range
  return hostOpener(
    job.host,
    { root, manifest: built.project.manifest },
    {
      revision: job.revision,
      ...(job.variant ? { variant: job.variant } : {}),
      params: job.params,
      seed: job.seed,
      ...(range ? { range } : {}),
      bakes: built.bakes,
      trusted: o.trusted,
      timeoutMs: o.timeoutMs,
      build: async () => built,
    },
  )
}

/**
 * Opens a job in its host: checks it (verifyJob), then opens the revision's frozen copy with the
 * job's manifest (its variant), params and seed. The returned project's root is that copy, so
 * audio and assets resolve inside it.
 *
 * The first render pins the host it ran on (`versions/jobs/<name>.host.json`: Node version, Chrome
 * build and flags, GPU adapter); a later render on another one is refused with ChangedEnvironment,
 * since exact pixels are promised only within one host on one machine. `range: 'sdr'` opens an
 * hdr10 job's SDR version (its review looks at that, decision 0023).
 */
export const openJob = async (
  root: string,
  job: Job,
  o: { trusted?: boolean; timeoutMs?: number; range?: Range } = {},
  extra: (manifest: Manifest) => number = () => 0,
): Promise<{ project: Project; child: Child; more: () => Promise<Child>; extra: Child[] }> => {
  const built = await verifyJob(root, job)
  const more = await frozenOpener(root, built, job, o)
  // The extra hosts a run needs open at once with the first (openHosts).
  const [child, ...others] = (await openHosts(more, 1 + extra(built.project.manifest))) as [
    Child,
    ...Child[],
  ]
  try {
    const now = await child.identity()
    const file = pinFile(root, job.name)
    // Linked into place whole, as createJob does: of two first renders one pins, and the other
    // (or any reader) never sees half a pin.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(now, null, 1)}\n`)
    let pinned = true
    try {
      linkSync(tmp, file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      pinned = false
    } finally {
      rmSync(tmp, { force: true })
    }
    if (!pinned) {
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
    await Promise.all([child, ...others].map((h) => h.close()))
    throw error
  }
  // Another host on the same frozen build, for a parallel export.
  return { project: built.project, child, more, extra: others }
}

/** An SDR mp4 master's delivery with the x264 settings it renders with now recorded (#496). */
export const recordX264 = (d: Partial<Delivery>, range?: Range): Partial<Delivery> =>
  (d.format ?? 'mp4') === 'mp4' && d.quality === 'master' && range !== 'hdr10'
    ? { ...d, x264: { preset: QUALITIES.master.preset, crf: QUALITIES.master.crf } }
    : d

/** The master every job made by 0.2.1 or earlier renders, recording no x264 settings. */
const MASTER_021: X264 = { preset: 'slow', crf: 12 }

/**
 * What a delivery asks of a video export (exportVideo's VideoOptions). A master's x264 settings
 * are the ones it recorded (recordX264), or 0.2.1's when it recorded none.
 */
export const videoOptionsOf = (d: Partial<Delivery>) => ({
  codec: d.format === 'prores-hq' || d.format === 'prores-4444' ? d.format : ('h264' as const),
  ...((d.format ?? 'mp4') === 'mp4' && d.quality === 'master'
    ? { x264: d.x264 ?? MASTER_021 }
    : {}),
  ...(d.bitrate ? { bitrate: d.bitrate } : {}),
  ...(d.maxrate ? { maxrate: d.maxrate } : {}),
  ...(d.editList === false ? { editList: false } : {}),
  ...(d.stems ? { stems: true } : {}),
})

/**
 * Opens a saved revision (not a job) in its own host, from its frozen copy, as `openJob` does: the
 * revision's own manifest, `variant` and `params` over its defaults, and the bakes its stamps pin
 * for it. `close` ends the host and releases the copy, which stays in the pool of frozen copies
 * (revisions.ts). An unknown revision says "No revision", a pruned one "was pruned".
 */
export const openRevision = async (
  root: string,
  revision: string,
  o: {
    variant?: string
    params?: { readonly [key: string]: Json }
    host?: unknown
    trusted?: boolean
    timeoutMs?: number
  } = {},
): Promise<{ project: Project; child: Child; close: () => Promise<void> }> => {
  const built = await frozenBuild(root, revision, o.variant)
  try {
    const declared = manifestAt(root, revision)
    const { manifest, params: variantParams } = withVariant(declared, o.variant)
    const params = effectiveParams(manifest, variantParams, o.params)
    const pinned = pinBakes(root, declared, revision, readRevision(root, revision).files)
    const bakes = checkJobBakes({
      name: `revision ${revision}`,
      revision,
      inputs: { bakes: pinned },
    })
    const more = await hostOpener(
      hostOf(manifest, o.host),
      { root, manifest: built.project.manifest },
      {
        revision,
        ...(o.variant ? { variant: o.variant } : {}),
        params,
        bakes,
        trusted: o.trusted,
        timeoutMs: o.timeoutMs,
        build: async () => built,
      },
    )
    const child = await more()
    return {
      project: built.project,
      child,
      close: async () => {
        try {
          await child.close()
        } finally {
          releaseFrozen(root, revision)
        }
      },
    }
  } catch (error) {
    releaseFrozen(root, revision)
    throw error
  }
}
