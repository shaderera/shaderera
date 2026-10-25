import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../node/project.ts'
import { listJobs } from '../project/jobs.ts'
import { head, log, prunedIds } from '../project/revisions.ts'
import { parse } from './args.ts'

/** `shaderera versions [--json]`: what was saved, restored and undone, newest last, and the jobs. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, { json: { type: 'boolean' } })
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  // A line whose revision `prune` removed stays, marked pruned.
  const pruned = prunedIds(root)
  const gone = (id: string) =>
    pruned.has(id) && !existsSync(join(root, 'versions', 'revisions', `${id}.json`))
  const entries = log(root).map((e) => (gone(e.id) ? { ...e, pruned: true } : e))
  const jobs = listJobs(root)
  if (v.json) {
    console.log(JSON.stringify({ head: head(root), log: entries, jobs }, null, 2))
    return 0
  }
  for (const e of entries)
    console.log(
      `${e.at}  ${e.action.padEnd(7)} ${e.id}  ${e.by}${e.label ? `  ${e.label}` : ''}${'pruned' in e ? '  (pruned)' : ''}`,
    )
  for (const j of jobs)
    console.log(
      `job ${j.name}  revision ${j.revision}  ${j.output.width}×${j.output.height} ${j.output.from}–${j.output.to} s`,
    )
  if (entries.length === 0) console.log('No saved revisions yet: shaderera save')
  return 0
}
