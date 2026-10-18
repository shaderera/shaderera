// The notices of what a web player bundles (docs/licences.md#the-web-player). MIT, BSD and
// Apache-2.0 ask that a package's copyright and licence notice go with every copy, and the bundler
// keeps only `/*!` and `@license` comments, so the build writes them beside the code instead.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** Where a player keeps them; runner.html names it. */
export const NOTICES_FILE = 'assets/THIRD-PARTY-NOTICES.txt'

type Package = { name: string; version: string; license: string; root: string; files: Set<string> }

/** A package's own licence and notice files, as npm and the licences themselves name them. */
const LICENCE_FILE = /^(licen[cs]e|notice)([.-].*)?$/i

/**
 * Where a bundler's licence file stops speaking of its own code: Vite's (as Rollup's) goes on with
 * the licences of what its own dist bundles, none of which is in a player, for some 100 kB.
 */
const BUNDLED_SECTION = /^#+ Licenses of bundled dependencies/im

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

/** The nearest folder at or above `dir` whose package.json has a name: the package's root. */
const packageRoot = (dir: string): string | undefined => {
  for (let d = dir; ; d = dirname(d)) {
    const pkg = join(d, 'package.json')
    if (existsSync(pkg) && typeof readJson(pkg).name === 'string') return d
    if (dirname(d) === d) return undefined
  }
}

const require = createRequire(import.meta.url)
const resolvePackage = (name: string, from: string) =>
  dirname(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`))
/** The bundler's own runtime helpers, which it adds as virtual modules (`\0vite/…`, `\0rolldown/…`). */
const helperRoot = (id: string): string | undefined => {
  if (!/^\0(vite|rolldown)\//.test(id)) return undefined
  const vite = dirname(require.resolve('vite/package.json'))
  return id.startsWith('\0vite/') ? vite : resolvePackage('rolldown', vite)
}

/** The leading block comments of a file that carry a copyright or licence. */
const headerNotices = (file: string): string[] => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const found: string[] = []
  const comment = /\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/y
  for (let m = comment.exec(text); m; m = comment.exec(text)) {
    const c = m[0].trim()
    if (c.startsWith('/*') && /copyright|licen[cs]e/i.test(c))
      found.push(c.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''))
  }
  return found
}

const isFilms = (file: string, filmRoot: string) => {
  const r = relative(filmRoot, file)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('node_modules')
}

/**
 * The notices file for the modules a build bundled (each chunk's module ids). Every module outside
 * the film's own code is mapped to its package, and each package, sorted by name, gets its name,
 * version and licence from its package.json, then its licence and notice files, then the distinct
 * licence headers of its bundled files. The film's own code is the author's and is left out; its
 * npm dependencies, the engine's packages and the bundler's runtime helpers are not.
 */
export const thirdPartyNotices = (moduleIds: Iterable<string>, filmRoot: string): string => {
  const packages = new Map<string, Package>()
  for (const id of moduleIds) {
    const helper = helperRoot(id)
    const file = id.split('?')[0] ?? id
    if (!helper && (id.startsWith('\0') || !isAbsolute(file) || isFilms(file, filmRoot))) continue
    const root = helper ?? packageRoot(dirname(file))
    if (!root) continue
    const json = readJson(join(root, 'package.json'))
    const name = String(json.name)
    const version = String(json.version ?? '')
    const key = `${name}@${version}`
    let pkg = packages.get(key)
    if (!pkg) {
      const license = typeof json.license === 'string' ? json.license : 'not stated'
      pkg = { name, version, license, root, files: new Set() }
      packages.set(key, pkg)
    }
    if (!helper) pkg.files.add(file)
  }
  const sorted = [...packages.values()].sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  )
  const rule = '='.repeat(78)
  const parts = [
    'Third-party notices',
    '',
    "This web player bundles the packages below, besides the film's own code. Each is listed with",
    'the licence its package.json names, its licence and notice files, and the licence headers of',
    'its bundled files, which the bundler does not keep in the code.',
    '',
    ...sorted.map((p) => `- ${p.name} ${p.version} (${p.license})`),
  ]
  for (const p of sorted) {
    parts.push('', rule, `${p.name} ${p.version}`, `License: ${p.license}`, rule)
    const files = readdirSync(p.root)
      .filter((f) => LICENCE_FILE.test(f))
      .sort()
    if (files.length === 0) parts.push('', '(The package has no licence file.)')
    for (const f of files) {
      const text = readFileSync(join(p.root, f), 'utf8').replace(/\r\n/g, '\n')
      const cut = text.search(BUNDLED_SECTION)
      parts.push('', `--- ${f}`, '', (cut < 0 ? text : text.slice(0, cut)).trimEnd())
      if (cut >= 0)
        parts.push('', `(The rest of ${f} lists the licences of what ${p.name} itself bundles.)`)
    }
    const headers = new Set([...p.files].sort().flatMap(headerNotices))
    if (headers.size > 0) parts.push('', '--- In its files', '', [...headers].join('\n\n'))
  }
  return `${parts.join('\n')}\n`
}
