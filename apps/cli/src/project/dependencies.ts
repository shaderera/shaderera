import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join } from 'node:path'
import { hashFile } from './revisions.ts'

/**
 * The installed packages a frozen job executes, by content: `name@version` → sha256 of the
 * package's files. A job records them when it is made, and every host compares them before it
 * renders the job, so a package changed in node_modules (same version, different code) is refused
 * rather than rendered under the job's name.
 */
export type Packages = { [nameAtVersion: string]: string }

/** The package a bare import names (`three/webgpu` → `three`), or null for anything else. */
export const packageOf = (specifier: string): string | null => {
  if (/^(\.|\/|[a-zA-Z]:|[a-z]+:|\0)/.test(specifier) || isBuiltin(specifier)) return null
  const parts = specifier.split('/')
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/')
}

/** An installed package's folder (real path), found the way Node finds it, or null. */
export const locate = (name: string, from: string): string | null => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) return null
  }
}

/** sha256 over a package's files, each by path and content, without its own node_modules. */
const hashPackage = (dir: string): string => {
  const h = createHash('sha256')
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at).sort()) {
      if (name === 'node_modules') continue
      const full = join(at, name)
      const path = rel ? `${rel}/${name}` : name
      const s = lstatSync(full)
      if (s.isSymbolicLink()) h.update(`${path}\0-> ${readlinkSync(full)}\n`)
      else if (s.isDirectory()) walk(full, path)
      else if (s.isFile()) h.update(`${path}\0${hashFile(full)}\n`)
    }
  }
  walk(dir, '')
  return h.digest('hex')
}

/**
 * The packages `required` and `optional` resolve to from `from`, with everything they depend on
 * (dependencies; optionalDependencies and peerDependencies when installed). `missing` lists the
 * required names that are not installed.
 */
export const installedPackages = (
  from: string,
  required: readonly string[],
  optional: readonly string[] = [],
): { packages: Packages; missing: string[] } => {
  const packages: Packages = {}
  const missing: string[] = []
  const seen = new Set<string>()
  const visit = (name: string, at: string, needed: boolean) => {
    const dir = locate(name, at)
    if (!dir) {
      if (needed) missing.push(name)
      return
    }
    if (seen.has(dir)) return
    seen.add(dir)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string
      version?: string
      dependencies?: object
      optionalDependencies?: object
      peerDependencies?: object
    }
    packages[`${pkg.name ?? name}@${pkg.version ?? '0.0.0'}`] = hashPackage(dir)
    for (const d of Object.keys(pkg.dependencies ?? {})) visit(d, dir, true)
    for (const d of Object.keys({ ...pkg.optionalDependencies, ...pkg.peerDependencies }))
      visit(d, dir, false)
  }
  for (const name of required) visit(name, from, true)
  for (const name of optional) visit(name, from, false)
  return {
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
    missing,
  }
}

/** How the installed packages differ from the ones a job recorded, one line each. */
export const packageChanges = (recorded: Packages, now: Packages): string[] =>
  [...new Set([...Object.keys(recorded), ...Object.keys(now)])]
    .sort()
    .flatMap((k) =>
      recorded[k] === now[k]
        ? []
        : [
            !(k in now)
              ? `${k} is no longer installed`
              : !(k in recorded)
                ? `${k} is installed now but was not part of the job`
                : `${k} has different contents than when the job was made`,
          ],
    )
