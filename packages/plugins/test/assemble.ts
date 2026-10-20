// The items as `add` would lay them out in one project: each file at its path, so items built on
// other items import them as a project would. Under out/, so node_modules still resolve.
// items.test.ts renders from it and `pnpm typecheck` checks it: `node test/assemble.ts` makes it.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const assemble = () => {
  const plugins = join(import.meta.dirname, '..')
  const project = join(plugins, 'out', 'assembled')
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
  return project
}

if (import.meta.main) assemble()
