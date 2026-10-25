import { findProject } from '../node/project.ts'
import { prune } from '../project/prune.ts'
import { parse } from './args.ts'
import { found } from './findings.ts'

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`

/**
 * `shaderera prune [--dry-run] [--keep n]`: removes the saved revisions nobody names and the
 * objects only they held (project/prune.ts), printing what it removes; `--dry-run` prints the
 * same and removes nothing.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, { 'dry-run': { type: 'boolean' }, keep: { type: 'string' } })
  const keep = v.keep === undefined ? 10 : Number(v.keep)
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const dryRun = v['dry-run'] === true
  const r = prune(root, { keep, dryRun })
  for (const k of r.kept) console.log(`keep    ${k.id}  ${k.why.join(', ')}`)
  for (const id of r.removed) console.log(`${dryRun ? 'would remove' : 'removed'} ${id}`)
  console.log(
    `${dryRun ? 'would remove' : 'removed'} ${r.removed.length} revision(s) and ${r.objects.length} object(s): ${mb(r.bytes)}${dryRun ? ' (dry run: nothing was removed)' : ''}`,
  )
  if (r.left.length > 0) {
    const message = `${r.left.length} revision(s) could not be removed now (${r.left.join(', ')}: a file held open?); run shaderera prune again to finish.`
    console.warn(`! ${message}`)
    found({ code: 'prune', severity: 'warning', message })
  }
  return 0
}
