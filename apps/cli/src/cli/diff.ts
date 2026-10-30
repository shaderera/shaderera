import { findProject } from '../node/project.ts'
import { diffRevisions } from '../project/diff.ts'
import { parseWithPositionals } from './args.ts'

/**
 * `shaderera diff <a> [<b>] [--stat] [--json]`: the files and text that changed from revision a to
 * b (or now). `--json` prints them as MCP `diff` gives them.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseWithPositionals(argv, {
    stat: { type: 'boolean' },
    json: { type: 'boolean' },
  })
  const [a, b] = positionals
  if (!a) throw new Error('diff needs a revision id (see shaderera versions)')
  const { root } = await findProject(values.root ?? process.cwd())
  const d = diffRevisions(root, a, b)
  if (values.json) {
    const { added, removed, changed } = d
    console.log(JSON.stringify(values.stat ? { added, removed, changed } : d, null, 2))
    return 0
  }
  for (const p of d.added) console.log(`added    ${p}`)
  for (const p of d.removed) console.log(`removed  ${p}`)
  for (const p of d.changed) console.log(`changed  ${p}`)
  if (!values.stat && d.patch) console.log(`\n${d.patch}`)
  return 0
}
