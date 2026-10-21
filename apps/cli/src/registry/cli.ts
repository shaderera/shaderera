import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { add, findRoot, remove } from './project.ts'
import { isUrl, mirror } from './remote.ts'
import { search } from './search.ts'
import { parseSpec, publish, readIndex, registryDir, resolve } from './store.ts'

/** The plugin commands, run as `shaderera <command>` (decision 0008). */
export const COMMANDS = ['add', 'search', 'info', 'remove', 'publish'] as const

export const usage = `Plugins:
  add <name>[@range] [--force]               copy a plugin into this project (a package is installed)
  search <words> [--type t] [--category c] [--tag x] [--json]   full-text over names, descriptions and code
  info <name>[@range] [--json]               what it is, its licence, what it copies, how to use it
  remove <name>                              uninstall a package plugin (copied files are yours: delete them)
  publish [dir] --site <folder> [--force]    put a plugin into a folder of plugins

Plugins come from a site's /r: --site <origin>, else SHADERERA_SITE, else https://shaderera.com/r;
or from a folder of plugins: --site <dir>.`

/** Runs one plugin command; `argv` is what follows it. */
export const run = async (command: string, argv: readonly string[]): Promise<number> => {
  const { values: v, positionals: args } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      site: { type: 'string' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      type: { type: 'string' },
      category: { type: 'string' },
      tag: { type: 'string' },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (v.help) {
    console.log(usage)
    return 0
  }
  const source = registryDir(v.site)
  if (command === 'publish' && isUrl(source))
    throw new Error(`publish writes to a folder, not ${source}: pass --site <dir>`)
  const registry = isUrl(source) ? await mirror(source, command, args) : source
  const root = () => findRoot(v.root ?? process.cwd())
  const print = (lines: string[]) => {
    for (const l of lines) console.log(l)
    return 0
  }
  // Plugins served over HTTP are read from their local mirror: messages name the URL, not the copy.
  try {
    return await dispatch()
  } catch (e) {
    throw isUrl(source) ? new Error((e as Error).message.split(registry).join(source)) : e
  }
  async function dispatch(): Promise<number> {
    switch (command) {
      case 'search': {
        const lower = (s: string) => s.toLowerCase()
        const hits = search(registry, args.join(' ')).filter(
          (h) =>
            (!v.type || h.type === v.type) &&
            (!v.category || lower(h.category) === lower(v.category)) &&
            (!v.tag || h.tags.split('\n').some((t) => lower(t) === lower(v.tag ?? ''))),
        )
        if (v.json) return print([JSON.stringify(hits, null, 2)])
        if (hits.length === 0) return print([`nothing for "${args.join(' ')}" in ${source}`])
        return print(
          hits.map(
            (h) =>
              `${h.name}@${h.version}  [${h.type} · ${h.category}]  ${h.title}${h.description ? ` — ${h.description}` : ''}`,
          ),
        )
      }
      case 'info': {
        const spec = args[0]
        if (!spec) throw new Error('Usage: shaderera info <name>[@range]')
        const found = resolve(registry, spec)
        const versions = Object.keys(
          readIndex(registry).items[parseSpec(spec).name]?.versions ?? {},
        )
        if (v.json) return print([JSON.stringify({ ...found, versions }, null, 2)])
        const i = found.item
        return print([
          `${i.name}@${i.version}  ${i.title}`,
          `  ${i.type} · ${i.category}${i.tags.length ? ` · ${i.tags.join(', ')}` : ''}`,
          ...(i.description ? [`  ${i.description}`] : []),
          `  licence ${i.licence} (the plugin's; the engine has its own)`,
          `  requires shaderera ${i.requires.shaderera ?? 'any'}${Object.entries(
            i.requires.extensions,
          )
            .map(([n, r]) => `, ${n} ${r}`)
            .join('')}`,
          ...(Object.keys(i.requires.items ?? {}).length
            ? [
                `  built on ${Object.entries(i.requires.items)
                  .map(([n, r]) => `${n} ${r}`)
                  .join(', ')} (copied in with it)`,
              ]
            : []),
          ...(Object.keys(i.requires.packages ?? {}).length
            ? [
                `  npm ${Object.entries(i.requires.packages)
                  .map(([n, r]) => `${n}@${r}`)
                  .join(', ')} (installed with it)`,
              ]
            : []),
          ...(i.files.length ? [`  files ${i.files.join(', ')}`] : []),
          ...(i.source
            ? [
                `  source ${i.source.origin}${i.source.generator ? ` (made with ${i.source.generator}; ${i.source.terms ?? 'terms not recorded'})` : ''}`,
              ]
            : []),
          `  versions ${versions.join(', ')}`,
          `  sha256 ${found.sha256}`,
          // How to use it, from the plugin's README, so the choice is made before anything is copied.
          ...(existsSync(join(found.dir, 'README.md'))
            ? ['', readFileSync(join(found.dir, 'README.md'), 'utf8').trimEnd()]
            : []),
        ])
      }
      case 'add': {
        if (!args[0]) throw new Error('Usage: shaderera add <name>[@range]')
        return print(add(root(), registry, args[0], { force: v.force ?? false }))
      }
      case 'remove': {
        if (!args[0]) throw new Error('Usage: shaderera remove <name>')
        return print(remove(root(), args[0]))
      }
      case 'publish': {
        const r = publish(args[0] ?? process.cwd(), registry, { force: v.force ?? false })
        return print([
          `published ${r.item.name}@${r.item.version} to ${registry} (sha256 ${r.sha256.slice(0, 12)})`,
          ...r.warnings.map((w) => `  ! ${w}`),
        ])
      }
      default:
        console.log(usage)
        return 1
    }
  }
}
