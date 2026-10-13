// Copies every plugin's files into this project at their paths, the way
// `shaderera add` lays them out (and test/items.test.ts assembles them), so a preview
// imports an item exactly as a film would. The copies are gitignored; run this after an item
// changes.
//   node scripts/assemble.ts

import { cpSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const project = join(import.meta.dirname, '..')
const plugins = join(project, '..')
for (const item of readdirSync(plugins)) {
  let label: { files?: string[] }
  try {
    label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8'))
  } catch {
    continue
  }
  for (const f of label.files ?? []) cpSync(join(plugins, item, f), join(project, f))
}
