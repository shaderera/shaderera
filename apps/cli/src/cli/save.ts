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
  // The same files as a revision already saved: that one is the save, and its label stays its own.
  if (r.existing)
    console.log(
      `same files as revision ${r.id}${typeof v.label === 'string' ? '; label added' : '; nothing new to save'}`,
    )
  else console.log(`${r.id}  ${Object.keys(r.files).length} files${r.label ? `  ${r.label}` : ''}`)
  return 0
}
