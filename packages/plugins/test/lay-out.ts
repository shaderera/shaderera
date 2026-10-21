// An item copied into a project of its own the way `add` lays it out, with the items it requires,
// under out/<item> (or out/<into>, for a test that lays out an item another test also lays out) so
// node_modules still resolve. Returns an import of a file at its project path.

import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugins = join(import.meta.dirname, '..')

type Label = { files?: string[]; requires?: { items?: Record<string, string> } }
const label = (item: string): Label =>
  JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8'))

export const layOut = (item: string, into = item) => {
  const project = join(plugins, 'out', into)
  rmSync(project, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  const copy = (name: string) => {
    const l = label(name)
    for (const f of l.files ?? [])
      cpSync(join(plugins, name, f), join(project, f), { recursive: true })
    for (const dep of Object.keys(l.requires?.items ?? {})) copy(dep)
  }
  copy(item)
  return (path: string): Promise<unknown> => import(pathToFileURL(join(project, path)).href)
}
