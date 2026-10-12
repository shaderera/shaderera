import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { ITEM_FILE } from './item.ts'
import { npm } from './npm.ts'
import { installedVersion, setRequirement } from './requires.ts'
import { parseVersion, satisfies as satisfiesRange } from './semver.ts'
import { folderName, latest, parseSpec, readIndex, resolve, versionDir } from './store.ts'

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
 * Makes an installed extension the project's own code: copies it into vendor/<name>, points the
 * dependency there (imports stay as they are), and stops requiring it from the registry.
 */
export const eject = (root: string, name: string): string[] => {
  let dir = root
  let found: string | null = null
  for (;;) {
    const p = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(p, 'package.json'))) {
      found = p
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (!found)
    throw new Error(`${name} is not installed; add it first, or drop it and write your own`)
  const target = join(root, 'vendor', folderName(name))
  cpSync(found, target, {
    recursive: true,
    filter: (p) => !relative(found, p).split(sep).includes('node_modules'),
  })
  const file = join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  for (const field of ['dependencies', 'devDependencies'] as const)
    if (pkg[field]?.[name]) delete pkg[field][name]
  pkg.dependencies = { ...pkg.dependencies, [name]: `file:vendor/${folderName(name)}` }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  setRequirement(root, name, null)
  return [
    `ejected ${name} into vendor/${folderName(name)}: it is this project's code now, change anything`,
    'run npm install so the dependency points at vendor/',
  ]
}

/** Stops requiring an extension; the code that imports it is the project's to replace. */
export const drop = (root: string, name: string): string[] => {
  setRequirement(root, name, null)
  return [
    `${name} is no longer required by ${ITEM_FILE}`,
    `replace what imports it with your own code, then npm uninstall ${name}`,
  ]
}

/** Lines matching `pattern` in the newest version of every item: `name@version file:line: text`. */
export const grep = (registry: string, pattern: string): string[] => {
  const re = new RegExp(pattern)
  const out: string[] = []
  const walk = (dir: string, base: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e)
      return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join('/')]
    })
  for (const v of latest(readIndex(registry))) {
    const dir = versionDir(registry, v.item.name, v.item.version)
    for (const f of walk(dir, dir)) {
      if (!/\.(ts|tsx|js|mjs|wgsl|json|md|glsl)$/.test(f)) continue
      readFileSync(join(dir, f), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (re.test(line))
            out.push(`${v.item.name}@${v.item.version} ${f}:${i + 1}: ${line.trim()}`)
        })
    }
  }
  return out
}
