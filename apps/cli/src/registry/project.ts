import { cpSync, existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { npm } from './npm.ts'
import { installedVersion, readLabel, setRequirement } from './requires.ts'
import { parseVersion, satisfies as satisfiesRange } from './semver.ts'
import { parseSpec, resolve } from './store.ts'

/** The project folder: the nearest one up from `cwd` with a shaderera.json. */
export const findRoot = (cwd: string): string => {
  let dir = resolvePath(cwd)
  while (!existsSync(join(dir, 'shaderera.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`No shaderera.json in ${resolvePath(cwd)} or above it.`)
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
 * Adds `spec` (`name` or `name@range`) to the project at `root`: an extension is installed and
 * required; a component's, preset's or media item's files are copied in. What it requires comes
 * too, each item once, and all of it resolves before anything is copied. A piece it is built on
 * that the project already has is the project's own: only its missing files are copied. Returns
 * what was done.
 */
export const add = (
  root: string,
  registry: string,
  spec: string,
  o: { force?: boolean; install?: Installer } = {},
): string[] => {
  const install = o.install ?? npmInstall
  const tree: ReturnType<typeof resolve>[] = []
  const seen = new Set<string>()
  const visit = (want: string) => {
    const { name } = parseSpec(want)
    if (seen.has(name)) return
    seen.add(name)
    const v = resolve(registry, want)
    tree.push(v)
    for (const [ext, range] of Object.entries(v.item.requires.extensions)) {
      const have = installedVersion(root, ext)
      if (!have || !satisfiesRange(have, range)) visit(`${ext}@${range}`)
    }
    for (const [piece, range] of Object.entries(v.item.requires.items)) visit(`${piece}@${range}`)
  }
  visit(spec)
  const clash = (tree[0]?.item.files ?? []).filter((f) => existsSync(join(root, f)))
  if (clash.length > 0 && !o.force)
    throw new Error(
      `the project already has ${clash.join(', ')}; use --force to replace ${clash.length === 1 ? 'it' : 'them'}`,
    )
  const done: string[] = []
  for (const [i, { item, dir }] of tree.entries()) {
    if (item.type === 'extension') {
      install(root, join(dir, 'package.tgz'))
      setRequirement(root, item.name, `^${item.version}`)
      done.push(`installed ${item.name}@${item.version} (${item.licence})`)
      continue
    }
    const files = i === 0 ? item.files : item.files.filter((f) => !existsSync(join(root, f)))
    for (const f of files) cpSync(join(dir, f), join(root, f), { recursive: true, force: true })
    if (i === 0 || files.length > 0)
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
 * Uninstalls a package plugin and stops requiring it. A component's, preset's or media item's
 * files were copied in and are the project's own code, so only the person deletes them.
 */
export const remove = (root: string, name: string, o: { uninstall?: Installer } = {}): string[] => {
  const required = readLabel(root)?.requires?.extensions?.[name] !== undefined
  if (!required && installedVersion(root, name) === null)
    throw new Error(
      `${name} is not a package plugin this project uses. A copied plugin's files are this project's code: delete them.`,
    )
  ;(o.uninstall ?? npmUninstall)(root, name)
  setRequirement(root, name, null)
  return [`removed ${name}: replace what imported it with your own code`]
}
