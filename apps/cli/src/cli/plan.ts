import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  chunkStates,
  inputOf,
  makePlan,
  type Plan,
  progressOf,
  readPlan,
  refuseOtherPlan,
} from '../deliver/chunks.ts'
import { findProject } from '../node/project.ts'
import { openJob, readJob } from '../project/jobs.ts'
import { childOptions, parse } from './args.ts'

/**
 * `shaderera plan --job <name> [--chunks 4] [--out dir]`: splits a job's frames into chunks that
 * any machine with the project at the job's revision renders (`render --job <name> --chunk <i>`),
 * then `assemble` encodes them once. Opens the job once, to see the frames its host hands over.
 * Refuses a folder that holds another job's plan or chunks; the same job's is planned again.
 *
 * `shaderera plan --status [--plan dir | --job name] [--verify] [--json]`: where each chunk of a
 * plan stands (chunkStates), the frames done and the time left at the recorded pace.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {
    job: { type: 'string' },
    chunks: { type: 'string' },
    out: { type: 'string' },
    status: { type: 'boolean' },
    plan: { type: 'string' },
    verify: { type: 'boolean' },
    json: { type: 'boolean' },
  })
  if (v.status) {
    const dir =
      typeof v.plan === 'string'
        ? resolve(v.plan)
        : typeof v.job === 'string'
          ? join(
              (await findProject(typeof v.root === 'string' ? v.root : process.cwd())).root,
              'out',
              `${v.job}.plan`,
            )
          : undefined
    if (!dir) throw new Error('plan --status needs --plan <dir> (or --job <name> for its folder).')
    return status(dir, v.verify === true, v.json === true)
  }
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
  const dir = typeof v.out === 'string' ? resolve(v.out) : join(root, 'out', `${job.name}.plan`)
  // Before the job opens: another job's plan there is refused, untouched.
  refuseOtherPlan(dir, job)
  const { child } = await openJob(root, job, childOptions(v))
  let input: ReturnType<typeof inputOf>
  try {
    // The frames every chunk's host must hand over: what the final encoder reads.
    input = inputOf(job, child)
  } finally {
    await child.close()
  }
  const plan = makePlan(job, input, count)
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

/** `plan --status`: each chunk's state, the frames done of the total, and an ETA. */
const status = (dir: string, verify: boolean, json: boolean): number => {
  const plan: Plan = readPlan(dir)
  const states = chunkStates(plan, dir, verify)
  const progress = progressOf(plan, states)
  if (json) {
    console.log(
      JSON.stringify(
        {
          plan: dir,
          job: plan.job,
          jobId: plan.jobId,
          verified: verify,
          frames: { done: progress.done, total: progress.total },
          eta: progress.eta,
          chunks: states.map(({ record, ...s }) => ({
            ...s,
            ...(record ? { seconds: record.seconds, host: record.host } : {}),
          })),
        },
        null,
        2,
      ),
    )
    return 0
  }
  console.log(`${join(dir, 'plan.json')}: job ${plan.job}, ${states.length} chunks`)
  for (const s of states)
    console.log(
      `  chunk ${String(s.index).padStart(3)}  ${s.status.padEnd(8)}  ${s.frames} frames${s.reused ? ` reused from job ${s.reused.job}` : s.record && !s.problem ? ` in ${s.record.seconds.toFixed(1)} s` : ''}${s.problem && s.record ? `: ${s.problem}` : ''}${s.fix ? `  → ${s.fix}` : ''}`,
    )
  const eta =
    progress.eta === null
      ? ', no chunk rendered yet to time the rest'
      : progress.eta > 0
        ? `, about ${Math.ceil(progress.eta)} s of rendering left at the recorded pace`
        : ''
  console.log(`${progress.done}/${progress.total} frames done${eta}`)
  if (!verify && states.some((s) => s.status === 'done'))
    console.log('(--verify checks each file against its sha256)')
  return 0
}
