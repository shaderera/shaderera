import type { Json } from '@shaderera/core'
import { findProject } from '../node/project.ts'
import {
  checkHdr10Delivery,
  createJob,
  DELIVERY_FLAGS,
  deliveryOf,
  videoOptionsOf,
} from '../project/jobs.ts'
import { parse } from './args.ts'
import { checkVideoOptions } from './render.ts'

/**
 * `shaderera job [--variant name] [--params json] [--revision id] [--name n] [--label l]
 * [--from s] [--to s] [--host node|browser] [--format mp4|png|prores-hq|prores-4444] [--png]
 * [--master] [--bitrate 15M | --maxrate 10M] [--no-edit-list] [--stems] [--bits 16] [--hdr10] [--replace]`: freezes a render job in versions/jobs/ and
 * prints it. Without --revision the project is saved first, so the job renders exactly what is
 * there now. A --name that already holds different inputs is refused unless --replace is given.
 * --hdr10: the job renders in an hdr10 range to an HDR10 mp4 (decision 0023); the film's
 * shaderera.json must have `hdr10`.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {
    params: { type: 'string' },
    revision: { type: 'string' },
    name: { type: 'string' },
    label: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    replace: { type: 'boolean' },
    hdr10: { type: 'boolean' },
    ...DELIVERY_FLAGS,
  })
  const delivery = deliveryOf(v)
  checkVideoOptions(videoOptionsOf(delivery))
  if (v.hdr10) checkHdr10Delivery(delivery)
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
  const num = (x: unknown) => (typeof x === 'string' ? Number(x) : undefined)
  const job = await createJob(root, {
    by: 'cli',
    variant: str(v.variant),
    params: v.params ? (JSON.parse(String(v.params)) as { [key: string]: Json }) : undefined,
    revision: str(v.revision),
    name: str(v.name),
    label: str(v.label),
    host: v.host,
    ...(v.hdr10 ? { range: 'hdr10' as const } : {}),
    from: num(v.from),
    to: num(v.to),
    delivery,
    replace: v.replace === true,
  })
  console.log(JSON.stringify(job, null, 2))
  console.error(
    `saved versions/jobs/${job.name}.json — render it with: shaderera render --job ${job.name}`,
  )
  return 0
}
