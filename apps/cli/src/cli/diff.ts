import { findProject } from '../node/project.ts'
import { diffRevisions } from '../project/diff.ts'
import { parseWithPositionals } from './args.ts'

/** `shaderera diff <a> [<b>] [--stat]`: the files and text that changed from revision a to b (or now). */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseWithPositionals(argv, { stat: { type: 'boolean' } })
  const [a, b] = positionals
  if (!a) throw new Error('diff needs a revision id (see shaderera versions)')
  const { root } = await findProject(values.root ?? process.cwd())
  const d = diffRevisions(root, a, b)
  for (const p of d.added) console.log(`added    ${p}`)
  for (const p of d.removed) console.log(`removed  ${p}`)
  for (const p of d.changed) console.log(`changed  ${p}`)
  if (!values.stat && d.patch) console.log(`\n${d.patch}`)
  return 0
}
