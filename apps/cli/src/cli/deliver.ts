import { batchJobs, bytes, deliverBatch } from '../deliver/batch.ts'
import { findProject } from '../node/project.ts'
import { DELIVERY_FLAGS, deliveryOf, readJob, videoOptionsOf } from '../project/jobs.ts'
import { childOptions, parse } from './args.ts'
import { requireFfmpeg } from './ffmpeg.ts'
import { EXIT, found } from './findings.ts'
import { checkVideoOptions } from './render.ts'
import { checkFindings } from './review.ts'

const list = (x: unknown) =>
  typeof x === 'string'
    ? x
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined

/**
 * `shaderera deliver [--variants a,b] [--locales en,th] [--format mp4|png|prores-hq|prores-4444]
 * [--png] [--master] [--bitrate 15M | --maxrate 10M] [--no-edit-list] [--stems] [--bits 16]
 * [--no-audio] [--loudness LUFS] [--software-gpu]
 * [--name batch] [--job a --job b] [--replace]`: a campaign batch. One job per variant × locale from
 * the project as it is now (saved once as a revision), or the given jobs; each is rendered, reviewed
 * against its own format and what requirements.json declares, and indexed in
 * out/deliveries/<batch>/index.{json,md}. Exits 1 when any output fails a check or fails to render,
 * after rendering the rest.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {
    variants: { type: 'string' },
    locales: { type: 'string' },
    name: { type: 'string' },
    ...DELIVERY_FLAGS,
    job: { type: 'string', multiple: true },
    'no-audio': { type: 'boolean' },
    loudness: { type: 'string' },
    replace: { type: 'boolean' },
    'software-gpu': { type: 'boolean' },
  })
  requireFfmpeg()
  const delivery = deliveryOf(v)
  checkVideoOptions(videoOptionsOf(delivery))
  if (v.loudness !== undefined && !Number.isFinite(Number(v.loudness)))
    throw new Error('--loudness needs LUFS, such as -23 or -14.')
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const batch =
    typeof v.name === 'string'
      ? v.name
      : `batch-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
  if (!/^[\w.-]+$/.test(batch)) throw new Error(`A batch name is letters, digits, . _ -: ${batch}`)
  const given = Array.isArray(v.job) ? v.job.map((j) => readJob(root, String(j))) : undefined
  const jobs = await batchJobs(root, {
    batch,
    jobs: given,
    variants: list(v.variants) ?? (typeof v.variant === 'string' ? [v.variant] : undefined),
    locales: list(v.locales),
    delivery,
    replace: v.replace === true,
  })
  const { dir, index } = await deliverBatch(root, jobs, {
    batch,
    audio: v['no-audio'] !== true,
    ...(v.loudness === undefined ? {} : { loudness: Number(v.loudness) }),
    ...childOptions(v),
    softwareGpu: v['software-gpu'] === true,
    onOutput: (i, n, job) => process.stderr.write(`output ${i + 1}/${n} ${job.name}\n`),
  })
  for (const o of index.outputs) {
    for (const f of checkFindings(
      o.checks.map((c) => (c.required && c.status !== 'pass' ? { ...c, status: 'fail' } : c)),
      o.job,
    ))
      found(f)
    if (o.error) found({ code: 'error', severity: 'error', message: o.error, output: o.job })
    const fails = o.checks
      .filter((c) => c.status === 'fail' || (c.required && c.status !== 'pass'))
      .map((c) => c.id)
    console.log(
      `${o.status === 'pass' ? '✓' : '✗'} ${o.job}  ${o.file ?? '—'}  ${o.width}×${o.height} ${o.duration} s` +
        (o.bytes === undefined ? '' : `  ${bytes(o.bytes)}`) +
        (fails.length ? `  failing: ${fails.join(', ')}` : '') +
        (o.error ? `  error: ${o.error}` : ''),
    )
  }
  console.log(`${dir}/index.md`)
  return index.outputs.some((o) => o.status === 'fail') ? EXIT.failed : EXIT.ok
}
