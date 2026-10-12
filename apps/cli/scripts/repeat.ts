/**
 * Renders the same t many times in one Node child and counts the distinct frame hashes: more than
 * one means the source is not a function of t even without any change of history (a race).
 *
 *   node apps/cli/scripts/repeat.ts <project dir> <t> [--n 20] [--variant name] [--between t2]
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { open } from '../src/cli/args.ts'

const cli = createRequire(join(import.meta.dirname, '../package.json'))
const { sha256 } = await import(pathToFileURL(cli.resolve('@shaderera/core/host')).href)
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { variant: { type: 'string' }, n: { type: 'string' }, between: { type: 'string' } },
})
const [root = '.', at = '0'] = positionals
const t = Number(at)
const { child } = await open({ root, variant: values.variant })
const hashes: string[] = []
try {
  for (let i = 0; i < Number(values.n ?? 20); i++) {
    if (values.between) await child.render(Number(values.between), 'final')
    hashes.push((await sha256((await child.render(t, 'final')).pixels)).slice(0, 12))
  }
} finally {
  await child.close()
}
const counts = new Map<string, number>()
for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1)
console.log(JSON.stringify({ t, renders: hashes.length, distinct: Object.fromEntries(counts) }))
