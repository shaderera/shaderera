import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ITEM_FILE } from './item.ts'
import { add, findRoot, remove } from './project.ts'
import { isUrl, mirror } from './remote.ts'
import { search } from './search.ts'
import { parseSpec, publish, readIndex, registryDir, resolve } from './store.ts'

/** The plugin commands, run as `shaderera <command>` (decision 0008). */
export const COMMANDS = ['add', 'search', 'info', 'remove', 'publish'] as const

export const usage = `Plugins:
  add <name>[@range]... [--force]            copy plugins into this project (a package is installed)
  search <words> [--type t] [--category c] [--tag x] [--json]   full-text over names, descriptions and code
  info <name>[@range] [--json]               what it is, its licence, what it copies, how to use it
  remove <name>...                           uninstall package plugins (copied files are yours: delete them)
  publish [dir]... --site <folder> [--force] put plugins into a folder of plugins

Plugins come from a site's /r: --site <origin>, else SHADERERA_SITE, else https://shaderera.com/r;
or from a folder of plugins: --site <dir>.`

/**
 * A folder of plugin sources (each with its label) where a folder of published plugins was
 * wanted: the catalog itself, say. It has no index.json, so every name would be "not a plugin".
 */
const sourcesHint = (dir: string, command: string): string | null => {
  if (existsSync(join(dir, 'index.json')) || !existsSync(dir)) return null
  const sources = readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.isDirectory() && existsSync(join(dir, e.name, ITEM_FILE)),
  )
  return sources
    ? `${dir} holds plugin sources, not published plugins (it has no index.json). Publish them into a folder first, then ${{ add: 'add from that', search: 'search that', info: 'run info on that' }[command] ?? 'use that'}: npx shaderera publish ${dir}/<plugin>... --site <folder> (see "Where plugins come from" in docs/plugins.md)`
    : null
}

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
  if (command !== 'publish' && !isUrl(source)) {
    const hint = sourcesHint(source, command)
    if (hint) throw new Error(hint)
  }
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
        if (!spec || args.length > 1)
          throw new Error('Usage: shaderera info <name>[@range] (one plugin at a time)')
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
        if (args.length === 0) throw new Error('Usage: shaderera add <name>[@range]...')
        const done = add(root(), registry, args, { force: v.force ?? false })
        return print(args.length > 1 ? [...done, `added ${args.join(', ')}`] : done)
      }
      case 'remove': {
        if (args.length === 0) throw new Error('Usage: shaderera remove <name>...')
        return print(remove(root(), args))
      }
      case 'publish': {
        // Each folder in turn: one that fails does not stop the rest, and is named at the end.
        const dirs = args.length > 0 ? args : [process.cwd()]
        const failed: string[] = []
        for (const dir of dirs) {
          try {
            const r = publish(dir, registry, { force: v.force ?? false })
            print([
              `published ${r.item.name}@${r.item.version} to ${registry} (sha256 ${r.sha256.slice(0, 12)})`,
              ...r.warnings.map((w) => `  ! ${w}`),
            ])
          } catch (e) {
            if (dirs.length === 1) throw e
            failed.push(`${dir}: ${(e as Error).message}`)
          }
        }
        if (dirs.length === 1) return 0
        const published = dirs.length - failed.length
        if (failed.length === 0) return print([`published ${published} of ${dirs.length}`])
        throw new Error(
          `published ${published} of ${dirs.length}; ${failed.length} failed:\n  ${failed.join('\n  ')}`,
        )
      }
      default:
        console.log(usage)
        return 1
    }
  }
}
