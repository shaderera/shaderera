import { findProject } from '../node/project.ts'
import { undo } from '../project/revisions.ts'
import { parse } from './args.ts'

/**
 * `shaderera undo [--json]`: returns the project to the previous revision (unsaved edits are saved
 * first). `--json` prints the revision it is now at, as MCP `undo` gives it.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, { json: { type: 'boolean' } })
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const { files, ...r } = undo(root, 'cli')
  console.log(
    v.json ? JSON.stringify(r, null, 2) : `now at ${r.id}${r.label ? `  ${r.label}` : ''}`,
  )
  return 0
}
