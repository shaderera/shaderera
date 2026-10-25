import { parseArgs } from 'node:util'
import { findProject } from '../node/project.ts'
import { type Entry, NOTE, record, tail } from '../project/activity.ts'
import { EXIT } from './findings.ts'

/** An entry as one line: its time, who, and what. */
const lineOf = (e: Entry): string => {
  const what =
    e.kind === 'command'
      ? `${e.command}${e.args?.length ? ` ${e.args.join(' ')}` : ''}: exit ${e.exitCode}`
      : e.kind === 'tool'
        ? `${e.tool}: ${e.ok ? 'ok' : 'failed'} in ${Math.round(e.ms)} ms`
        : e.kind === 'note'
          ? `${e.text}${e.comment ? ` (comment ${e.comment})` : ''}`
          : e.kind === 'edit'
            ? `edit: ${[...e.files.added, ...e.files.changed, ...e.files.removed].join(', ')}`
            : e.kind === 'render'
              ? `render ${e.format}${e.variant ? ` of ${e.variant}` : ''}: ${e.ok ? e.file : e.error}`
              : `share: ${e.ok ? e.url : e.error}`
  const summary = e.kind === 'command' || e.kind === 'tool' ? e.summary : undefined
  const counts =
    summary && summary.error + summary.warning > 0
      ? ` (${summary.error} error(s), ${summary.warning} warning(s))`
      : ''
  return `${e.at.slice(0, 19).replace('T', ' ')}  ${e.by.padEnd(6)} ${what}${counts}${e.image ? `  ${e.image}` : ''}`
}

/**
 * `shaderera activity [--last n] [--json]`: the project's activity, oldest first (decision 0025).
 * `shaderera activity add [--comment <id>] <text>`: adds a note of what the agent means to do.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      json: { type: 'boolean' },
      last: { type: 'string' },
      comment: { type: 'string' },
    },
  })
  const { root } = await findProject(values.root ?? process.cwd())
  const [what, ...words] = positionals
  if (what === 'add') {
    const text = words.join(' ').trim()
    if (!text) throw new Error('Usage: shaderera activity add [--comment <id>] <text>')
    if (text.length > NOTE) throw new Error(`A note is at most ${NOTE} characters.`)
    const entry = record(root, {
      by: 'cli',
      kind: 'note',
      text,
      ...(values.comment ? { comment: values.comment } : {}),
    })
    if (!entry) throw new Error(`Could not write ${root}/.shaderera/activity.jsonl.`)
    console.log(values.json ? JSON.stringify(entry) : entry.id)
    return EXIT.ok
  }
  if (what !== undefined)
    throw new Error(
      'Usage: shaderera activity [--last n] [--json] | activity add [--comment <id>] <text>',
    )
  const last = values.last === undefined ? 20 : Number(values.last)
  if (!(Number.isInteger(last) && last > 0)) throw new Error('--last needs a count above 0.')
  const entries = tail(root, last)
  console.log(
    values.json
      ? JSON.stringify(entries)
      : entries.length > 0
        ? entries.map(lineOf).join('\n')
        : 'No activity yet.',
  )
  return EXIT.ok
}
