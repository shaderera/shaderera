import { findProject } from '../node/project.ts'
import { undo } from '../project/revisions.ts'
import { parse } from './args.ts'

/** `shaderera undo`: returns the project to the previous revision (unsaved edits are saved first). */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {})
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const r = undo(root, 'cli')
  console.log(`now at ${r.id}${r.label ? `  ${r.label}` : ''}`)
  return 0
}
