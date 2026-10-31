import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { shadereraVersion } from '../deliver/environment.ts'
import { noProject } from '../node/project.ts'
import type { Item } from './item.ts'
import { npm } from './npm.ts'
import { installedPackage, installedVersion, readRequires, setRequirement } from './requires.ts'
import { parseVersion, satisfies as satisfiesRange } from './semver.ts'
import { parseSpec, resolve } from './store.ts'

/** The project folder: the nearest one up from `cwd` with a shaderera.json. */
export const findRoot = (cwd: string): string => {
  let dir = resolvePath(cwd)
  while (!existsSync(join(dir, 'shaderera.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw noProject(cwd)
    dir = parent
  }
  return dir
}

/**
 * Installs an extension's tarball or an npm package spec into a project, with npm `install` flags
 * (npm by default; tests pass their own).
 */
export type Installer = (root: string, tgz: string, flags?: string[]) => void
export const npmInstall: Installer = (root, tgz, flags = []) => {
  npm(['install', tgz, ...flags], { cwd: root, inherit: true })
}

export const npmUninstall: Installer = (root, name) => {
  npm(['uninstall', name], { cwd: root, inherit: true })
}

/** How npm saves a package an item imports: an exact version stays exact, types are dev only. */
export const saveFlags = (name: string, range: string): string[] => [
  ...(parseVersion(range) ? ['--save-exact'] : []),
  ...(name.startsWith('@types/') ? ['--save-dev'] : []),
]

/**
 * Writes a media plugin's record in the project's ASSETS.md (made when missing): its version,
 * licence, source and files, between markers, so adding it again replaces the record.
 */
export const recordAsset = (root: string, item: Item): void => {
  const file = join(root, 'ASSETS.md')
  const [open, close] = [`<!-- plugin ${item.name} -->`, `<!-- /plugin ${item.name} -->`]
  const s = item.source
  const record = [
    open,
    `## ${item.title} (\`${item.name}@${item.version}\`)`,
    '',
    `- Licence: ${item.licence}`,
    ...(s
      ? [
          `- Source: ${s.origin}`,
          ...(s.generator ? [`- Generator: ${s.generator}`] : []),
          ...(s.terms ? [`- Terms: ${s.terms}`] : []),
        ]
      : []),
    `- Files: ${item.files.map((f) => `\`${f}\``).join(', ')}`,
    '- Added by `shaderera add`.',
    close,
  ].join('\n')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '# Assets\n'
  const at = text.indexOf(open)
  const end = text.indexOf(close, at)
  writeFileSync(
    file,
    at >= 0 && end > at
      ? `${text.slice(0, at)}${record}${text.slice(end + close.length)}`
      : `${text.trimEnd()}\n\n${record}\n`,
  )
}

/**
 * Adds `specs` (each `name` or `name@range`) to the project at `root`: an extension is installed
 * and required; a component's, preset's or media item's files are copied in (a media item's record
 * goes in ASSETS.md). What they require
 * comes too, each item once, and all of it resolves before anything is copied: one that does not
 * resolve stops them all. A piece one is built on that the project already has is the project's
 * own: only its missing files are copied. A version that is not in a range another one requires
 * (a range named on the command line, say) is refused. Returns what was done, with a warning for
 * each one whose `requires.shaderera` this CLI (`version`) is not in: it is still added.
 */
export const add = (
  root: string,
  registry: string,
  specs: string | readonly string[],
  o: { force?: boolean; install?: Installer; version?: string } = {},
): string[] => {
  const install = o.install ?? npmInstall
  const wanted = typeof specs === 'string' ? [specs] : specs
  const named = new Set(wanted.map((s) => parseSpec(s).name))
  const tree: ReturnType<typeof resolve>[] = []
  const seen = new Set<string>()
  // Every range a piece requires, checked once all are chosen.
  const ranges: { by: string; name: string; range: string }[] = []
  // The named ones first, so a range given on the command line wins over one a piece requires.
  const take = (want: string) => {
    const { name } = parseSpec(want)
    if (seen.has(name)) return null
    seen.add(name)
    const v = resolve(registry, want)
    tree.push(v)
    return v
  }
  const visit = (v: ReturnType<typeof resolve> | null) => {
    if (!v) return
    for (const [ext, range] of Object.entries(v.item.requires.extensions)) {
      const have = installedVersion(root, ext)
      if (have && satisfiesRange(have, range)) continue
      ranges.push({ by: v.item.name, name: ext, range })
      visit(take(`${ext}@${range}`))
    }
    for (const [piece, range] of Object.entries(v.item.requires.items)) {
      ranges.push({ by: v.item.name, name: piece, range })
      visit(take(`${piece}@${range}`))
    }
  }
  for (const v of wanted.map(take)) visit(v)
  const chosen = new Map(tree.map(({ item }) => [item.name, item.version]))
  const conflicts = ranges.flatMap(({ by, name, range }) => {
    const version = chosen.get(name)
    return version && !satisfiesRange(version, range)
      ? [`${by} requires ${name} ${range}, not ${version}`]
      : []
  })
  if (conflicts.length > 0)
    throw new Error(
      `${conflicts.join('; ')}. Name a version in the range, or add them one at a time.`,
    )
  const clash = tree
    .filter(({ item }) => named.has(item.name))
    .flatMap(({ item }) => item.files)
    .filter((f) => existsSync(join(root, f)))
  if (clash.length > 0 && !o.force)
    throw new Error(
      `the project already has ${clash.join(', ')}; use --force to replace ${clash.length === 1 ? 'it' : 'them'}`,
    )
  const version = o.version ?? shadereraVersion()
  const done: string[] = tree.flatMap(({ item }) =>
    item.requires.shaderera && !satisfiesRange(version, item.requires.shaderera)
      ? [
          `! ${item.name}@${item.version} requires shaderera ${item.requires.shaderera}, not ${version}: update shaderera or add an older version`,
        ]
      : [],
  )
  for (const { item, dir } of tree) {
    if (item.type === 'extension') {
      // npm records the path it installed from: a copy in the project, so a clone or a cleared
      // cache still installs. Named as npm pack names it.
      const tgz = `vendor/${item.name.replace(/^@/, '').replace('/', '-')}-${item.version}.tgz`
      mkdirSync(join(root, 'vendor'), { recursive: true })
      cpSync(join(dir, 'package.tgz'), join(root, tgz))
      install(root, `./${tgz}`)
      setRequirement(root, item.name, `^${item.version}`)
      done.push(`installed ${item.name}@${item.version} (${item.licence})`)
      continue
    }
    const own = named.has(item.name)
    const files = own ? item.files : item.files.filter((f) => !existsSync(join(root, f)))
    for (const f of files) cpSync(join(dir, f), join(root, f), { recursive: true, force: true })
    if (item.type === 'media' && files.length > 0) recordAsset(root, item)
    if (own || files.length > 0)
      done.push(
        `copied ${item.type} ${item.name}@${item.version}: ${files.join(', ')} (${item.licence})`,
      )
  }
  // npm packages the copied code imports, unless a version in range is installed.
  for (const { item } of tree)
    for (const [name, range] of Object.entries(item.requires.packages)) {
      const have = installedVersion(root, name)
      if (have && satisfiesRange(have, range)) continue
      install(root, `${name}@${range}`, saveFlags(name, range))
      done.push(`installed ${name}@${range} (an npm package ${item.name} imports)`)
    }
  return done
}

/**
 * Uninstalls package plugins and stops requiring them. Each must be one the project uses (required
 * in its shaderera.json, or installed with a "shaderera" field), checked before any is uninstalled: a plain
 * npm dependency is never touched. A component's, preset's or media item's files were copied in and are
 * the project's own code, so only the person deletes them.
 */
export const remove = (
  root: string,
  names: string | readonly string[],
  o: { uninstall?: Installer } = {},
): string[] => {
  const all = [...new Set(typeof names === 'string' ? [names] : names)]
  const extensions = readRequires(root)?.extensions ?? {}
  const not = all.filter(
    (n) => extensions[n] === undefined && installedPackage(root, n)?.shaderera === undefined,
  )
  if (not.length > 0)
    throw new Error(
      `${not.join(', ')} ${not.length === 1 ? 'is not a package plugin' : 'are not package plugins'} this project uses. A copied plugin's files are this project's code: delete them.`,
    )
  return all.map((name) => {
    ;(o.uninstall ?? npmUninstall)(root, name)
    setRequirement(root, name, null)
    return `removed ${name}: replace what imported it with your own code`
  })
}
