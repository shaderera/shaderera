import { findProject } from '../node/project.ts'
import { restore } from '../project/revisions.ts'
import { parseWithPositionals } from './args.ts'

/**
 * `shaderera restore <revision> [--json]`: makes the project that revision (the current one is
 * saved first). `--json` prints the revision it is now at, as MCP `restore` gives it.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseWithPositionals(argv, { json: { type: 'boolean' } })
  const id = positionals[0]
  if (!id) throw new Error('restore needs a revision id (see shaderera versions)')
  const { root } = await findProject(values.root ?? process.cwd())
  const { files, ...r } = restore(root, id, 'cli')
  console.log(
    values.json ? JSON.stringify(r, null, 2) : `now at ${r.id}${r.label ? `  ${r.label}` : ''}`,
  )
  return 0
}
