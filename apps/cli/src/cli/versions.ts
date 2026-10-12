import { findProject } from '../node/project.ts'
import { listJobs } from '../project/jobs.ts'
import { head, log } from '../project/revisions.ts'
import { parse } from './args.ts'

/** `shaderera versions [--json]`: what was saved, restored and undone, newest last, and the jobs. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, { json: { type: 'boolean' } })
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const entries = log(root)
  const jobs = listJobs(root)
  if (v.json) {
    console.log(JSON.stringify({ head: head(root), log: entries, jobs }, null, 2))
    return 0
  }
  for (const e of entries)
    console.log(`${e.at}  ${e.action.padEnd(7)} ${e.id}  ${e.by}${e.label ? `  ${e.label}` : ''}`)
  for (const j of jobs)
    console.log(
      `job ${j.name}  revision ${j.revision}  ${j.output.width}×${j.output.height} ${j.output.from}–${j.output.to} s`,
    )
  if (entries.length === 0) console.log('No saved revisions yet: shaderera save')
  return 0
}
