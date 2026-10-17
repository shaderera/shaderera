import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inputOf, makePlan } from '../deliver/chunks.ts'
import { findProject } from '../node/project.ts'
import { openJob, readJob } from '../project/jobs.ts'
import { childOptions, parse } from './args.ts'

/**
 * `shaderera plan --job <name> [--chunks 4] [--out dir]`: splits a job's frames into chunks that
 * any machine with the project at the job's revision renders (`render --job <name> --chunk <i>`),
 * then `assemble` encodes them once. Opens the job once, to see the frames its host hands over.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {
    job: { type: 'string' },
    chunks: { type: 'string' },
    out: { type: 'string' },
  })
  if (typeof v.job !== 'string') throw new Error('plan needs --job <name>.')
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const job = readJob(root, v.job)
  if (job.delivery.format === 'png')
    throw new Error(
      'A png job is already one file per frame: split it into jobs by window (shaderera job --from --to) instead.',
    )
  const count = v.chunks === undefined ? 4 : Number(v.chunks)
  if (!(Number.isInteger(count) && count >= 1))
    throw new Error('--chunks is a whole number from 1.')
  const { child } = await openJob(root, job, childOptions(v))
  // The frames every chunk's host must hand over: what the final encoder reads.
  const input = inputOf(job, child)
  await child.close()
  const plan = makePlan(job, input, count)
  const dir = typeof v.out === 'string' ? resolve(v.out) : join(root, 'out', `${job.name}.plan`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
  console.log(
    `${join(dir, 'plan.json')}: ${plan.chunks.length} chunks of ${job.name}, frames as ${input}`,
  )
  for (const c of plan.chunks)
    console.log(
      `  npx shaderera render --job ${job.name} --chunk ${c.index}${v.out ? ` --plan ${dir}` : ''}   # ${c.frames} frames from ${Number(c.from.toFixed(4))} s`,
    )
  console.log(`then: npx shaderera assemble --plan ${dir}`)
  return 0
}
