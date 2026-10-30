import { findProject } from '../node/project.ts'
import { briefRevision, save } from '../project/revisions.ts'
import { parse } from './args.ts'

/**
 * `shaderera save [--label text] [--note text] [--json]`: saves the project as a revision. `--json`
 * prints the revision as MCP `save` gives it.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {
    label: { type: 'string' },
    note: { type: 'string' },
    json: { type: 'boolean' },
  })
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const r = save(root, {
    by: 'cli',
    label: typeof v.label === 'string' ? v.label : undefined,
    note: typeof v.note === 'string' ? v.note : undefined,
  })
  if (v.json) console.log(JSON.stringify(briefRevision(r), null, 2))
  // The same files as a revision already saved: that one is the save, and its label stays its own.
  else if (r.existing)
    console.log(
      `same files as revision ${r.id}${typeof v.label === 'string' ? '; label added' : '; nothing new to save'}`,
    )
  else console.log(`${r.id}  ${Object.keys(r.files).length} files${r.label ? `  ${r.label}` : ''}`)
  return 0
}
