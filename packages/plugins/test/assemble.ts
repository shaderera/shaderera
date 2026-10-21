// The items as `add` would lay them out in one project: each file at its path, so items built on
// other items import them as a project would. Under out/, so node_modules still resolve.
// items.test.ts imports it, and `typecheck` runs it so tsc sees the assembled project.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const plugins = join(import.meta.dirname, '..')
export const project = join(plugins, 'out', 'assembled')
rmSync(project, { recursive: true, force: true })
mkdirSync(project, { recursive: true })
for (const item of readdirSync(plugins)) {
  let label: { files?: string[] }
  try {
    label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8'))
  } catch {
    continue
  }
  for (const f of label.files ?? [])
    cpSync(join(plugins, item, f), join(project, f), { recursive: true })
}
