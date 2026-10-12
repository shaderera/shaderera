import { findProject } from '../node/project.ts'
import { save } from '../project/revisions.ts'
import { parse } from './args.ts'

/** `shaderera save [--label text] [--note text]`: saves the project as a revision. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, { label: { type: 'string' }, note: { type: 'string' } })
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const r = save(root, {
    by: 'cli',
    label: typeof v.label === 'string' ? v.label : undefined,
    note: typeof v.note === 'string' ? v.note : undefined,
  })
  console.log(`${r.id}  ${Object.keys(r.files).length} files${r.label ? `  ${r.label}` : ''}`)
  return 0
}
