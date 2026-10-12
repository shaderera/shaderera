import { findProject } from '../node/project.ts'
import { restore } from '../project/revisions.ts'
import { parseWithPositionals } from './args.ts'

/** `shaderera restore <revision>`: makes the project that revision (the current one is saved first). */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseWithPositionals(argv, {})
  const id = positionals[0]
  if (!id) throw new Error('restore needs a revision id (see shaderera versions)')
  const { root } = await findProject(values.root ?? process.cwd())
  const r = restore(root, id, 'cli')
  console.log(`now at ${r.id}${r.label ? `  ${r.label}` : ''}`)
  return 0
}
