import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { add, drop, eject, findRoot, grep } from './project.ts'
import { installedVersion, requirementProblems } from './requires.ts'
import { search } from './search.ts'
import { parseSpec, publish, readIndex, registryDir, resolve } from './store.ts'

const usage = `Usage: shaderera-registry <command> [--registry <dir>] [--json]

Find and use what others made, like npm for clips (decision 0008):
  search <words> [--type t] [--category c] [--tag x]   full-text over labels and code
  info <name>[@range]                                  label, versions, requires, files, how to use it
  grep <regex>                                         lines in the newest version of every item
  add <name>[@range] [--force]                         into this project (extensions are installed and required)
  eject <name>                                         an installed extension becomes this project's code (vendor/)
  drop <name>                                          stop requiring an extension; write your own
  verify                                               is everything this project requires installed?
  publish [dir] [--force]                              put an item (shaderera.item.json or package.json "shaderera") in the registry

The registry is a folder: --registry <dir>, else SHADERERA_REGISTRY, else ~/.shaderera/registry.`

/** The shaderera the project has (core and the CLI share one version), else this package's. */
const shadereraVersion = (root: string): string =>
  installedVersion(root, 'shaderera') ??
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const main = async (argv: readonly string[]): Promise<number> => {
  const { values: v, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      registry: { type: 'string' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      type: { type: 'string' },
      category: { type: 'string' },
      tag: { type: 'string' },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...args] = positionals
  if (!command || v.help) {
    console.log(usage)
    return v.help ? 0 : 1
  }
  const registry = registryDir(v.registry)
  const root = () => findRoot(v.root ?? process.cwd())
  const print = (lines: string[]) => {
    for (const l of lines) console.log(l)
    return 0
  }
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
      if (hits.length === 0) return print([`nothing for "${args.join(' ')}" in ${registry}`])
      return print(
        hits.map(
          (h) =>
            `${h.name}@${h.version}  [${h.type} · ${h.category}]  ${h.title}${h.description ? ` — ${h.description}` : ''}`,
        ),
      )
    }
    case 'info': {
      const spec = args[0]
      if (!spec) throw new Error('Usage: shaderera-registry info <name>[@range]')
      const found = resolve(registry, spec)
      const versions = Object.keys(readIndex(registry).items[parseSpec(spec).name]?.versions ?? {})
      if (v.json) return print([JSON.stringify({ ...found, versions }, null, 2)])
      const i = found.item
      return print([
        `${i.name}@${i.version}  ${i.title}`,
        `  ${i.type} · ${i.category}${i.tags.length ? ` · ${i.tags.join(', ')}` : ''}`,
        ...(i.description ? [`  ${i.description}`] : []),
        `  licence ${i.licence} (the item's; the engine has its own)`,
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
        // How to use it, from the item's README, so the choice is made before anything is copied.
        ...(existsSync(join(found.dir, 'README.md'))
          ? ['', readFileSync(join(found.dir, 'README.md'), 'utf8').trimEnd()]
          : []),
      ])
    }
    case 'grep': {
      if (!args[0]) throw new Error('Usage: shaderera-registry grep <regex>')
      return print(grep(registry, args[0]))
    }
    case 'add': {
      if (!args[0]) throw new Error('Usage: shaderera-registry add <name>[@range]')
      return print(add(root(), registry, args[0], { force: v.force ?? false }))
    }
    case 'eject': {
      if (!args[0]) throw new Error('Usage: shaderera-registry eject <name>')
      return print(eject(root(), args[0]))
    }
    case 'drop': {
      if (!args[0]) throw new Error('Usage: shaderera-registry drop <name>')
      return print(drop(root(), args[0]))
    }
    case 'verify': {
      const r = root()
      const problems = requirementProblems(r, shadereraVersion(r))
      if (problems.length === 0) return print(['✓ everything this project requires is installed'])
      print(problems.map((p) => `✗ ${p.name} ${p.range} (${p.problem})`))
      return 1
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

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (e) {
  console.error(
    process.env.SHADERERA_DEBUG ? e : `shaderera-registry: ${(e as Error).message ?? e}`,
  )
  process.exitCode = 1
}
