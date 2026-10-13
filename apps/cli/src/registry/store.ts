import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { checkItem, ITEM_FILE, type Item, rawItem } from './item.ts'
import { pack } from './npm.ts'
import { buildSearch, symbolsOf } from './search.ts'
import { compareVersions, satisfies } from './semver.ts'

/**
 * A registry is a folder, like a local npm or Docker registry: `index.json` lists every item and
 * version with its sha256; `search.json` is the full-text index the CLI searches without a
 * server; `items/<name>/<version>/` holds each version's files (an extension also keeps the
 * tarball npm installs, `package.tgz`). Versions are immutable. A team shares one folder (a
 * network drive or a git checkout): `--library <dir>` or `SHADERERA_LIBRARY`. A URL is the
 * same folder served over HTTP; without either, it is the official catalog.
 */
export const registryDir = (flag?: string): string =>
  flag ?? process.env.SHADERERA_LIBRARY ?? OFFICIAL

/** The official catalog: a registry folder served over HTTP, which remote.ts mirrors. */
export const OFFICIAL = 'https://shaderera.com/r'

export type Version = {
  readonly item: Item
  readonly sha256: string
  readonly published: string
  /** Exported names and WGSL functions, for search. */
  readonly symbols: readonly string[]
  /** Every file of the version, relative to its folder: what a registry served over HTTP downloads. */
  readonly files?: readonly string[]
}
export type Index = {
  readonly kind: 'shaderera.registry/1'
  readonly items: { [name: string]: { versions: { [version: string]: Version } } }
}

const emptyIndex = (): Index => ({ kind: 'shaderera.registry/1', items: {} })

export const readIndex = (registry: string): Index => {
  const file = join(registry, 'index.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : emptyIndex()
}

/** A package name as one folder name: `@scope/name` → `scope__name`. */
export const folderName = (name: string): string => name.replace(/^@/, '').replace('/', '__')

/** Where a version's files are. */
export const versionDir = (registry: string, name: string, version: string): string =>
  join(registry, 'items', folderName(name), version)

/** Every file under `dir`, relative to it. */
export const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory()
      ? walk(path, base)
      : [relative(base, path).split(sep).join('/')]
  })

/** The sha256 of a folder: of every file's path and sha256, in path order. */
export const hashDir = (dir: string): string => {
  const h = createHash('sha256')
  for (const f of walk(dir).sort()) {
    h.update(
      `${f}\0${createHash('sha256')
        .update(readFileSync(join(dir, f)))
        .digest('hex')}\n`,
    )
  }
  return h.digest('hex')
}

/** The files a component, preset or media item is made of, relative to the item. */
const filesOf = (item: Item, dir: string): string[] =>
  [
    ...new Set([
      ...item.files.flatMap((f) =>
        statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)).map((g) => `${f}/${g}`) : [f],
      ),
      ITEM_FILE,
      // How to use it: `info` prints it, search reads its first paragraph.
      'README.md',
    ]),
  ].filter((f) => existsSync(join(dir, f)))

/** Writes `file` whole or not at all: a reader never sees half of it. */
const writeWhole = (file: string, text: string): void => {
  writeFileSync(`${file}.partial`, text)
  renameSync(`${file}.partial`, file)
}

/**
 * Publishes the item in `dir`: checks its label, copies its files (an extension's are the ones npm
 * packs, beside the tarball), hashes them, and rebuilds the index and the search index. Refuses
 * a version that is already there unless `force`: once published, a version means the same
 * bytes. The version is built beside its folder and swapped in last, so a failure leaves the
 * published one as it was.
 */
export const publish = (
  dir: string,
  registry: string,
  o: { force?: boolean; now?: string } = {},
): { item: Item; sha256: string; warnings: string[] } => {
  const found = rawItem(dir)
  if (!found) throw new Error(`${dir} has no ${ITEM_FILE} and no "shaderera" field in package.json`)
  const { item, warnings } = checkItem(found.raw, found.file)
  const index = readIndex(registry)
  if (index.items[item.name]?.versions[item.version] && !o.force)
    throw new Error(`${item.name}@${item.version} is already published; bump the version`)
  const target = versionDir(registry, item.name, item.version)
  const partial = `${target}.partial`
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial, { recursive: true })
  const packed = item.type === 'extension' ? pack(dir, partial) : null
  if (packed) renameSync(join(partial, packed.tgz), join(partial, 'package.tgz'))
  const files = packed?.files ?? filesOf(item, dir)
  for (const f of files) cpSync(join(dir, f), join(partial, f), { recursive: true })
  const sha256 = hashDir(partial)
  const symbols = symbolsOf(partial, files)
  rmSync(target, { recursive: true, force: true })
  renameSync(partial, target)
  const entry = { versions: { ...index.items[item.name]?.versions } }
  entry.versions[item.version] = {
    item,
    sha256,
    published: o.now ?? new Date().toISOString(),
    symbols,
    files: walk(target).sort(),
  }
  const next: Index = { ...index, items: { ...index.items, [item.name]: entry } }
  writeWhole(join(registry, 'index.json'), `${JSON.stringify(next, null, 2)}\n`)
  writeWhole(join(registry, 'search.json'), JSON.stringify(buildSearch(latest(next))))
  return { item, sha256, warnings }
}

/** The newest version of every item. */
export const latest = (index: Index): Version[] =>
  Object.values(index.items).flatMap((e) => {
    const best = newest(Object.keys(e.versions), '*')
    return best ? [e.versions[best] as Version] : []
  })

/** The highest of `versions` in `range`, or null. */
export const newest = (versions: readonly string[], range: string): string | null =>
  versions
    .filter((v) => satisfies(v, range))
    .sort(compareVersions)
    .at(-1) ?? null

/** `name`, `name@range` or `@scope/name@range` → name and range ('*' when none). */
export const parseSpec = (spec: string): { name: string; range: string } => {
  const at = spec.indexOf('@', 1)
  return at < 0
    ? { name: spec, range: '*' }
    : { name: spec.slice(0, at), range: spec.slice(at + 1) || '*' }
}

/**
 * The version `spec` resolves to, checked against its sha256: it must still be the bytes
 * published. Its label is checked again too, since the index may have come from anywhere.
 */
export const resolve = (registry: string, spec: string): Version & { dir: string } => {
  const { name, range } = parseSpec(spec)
  const entry = readIndex(registry).items[name]
  if (!entry) throw new Error(`${name} is not in the library ${registry}`)
  const version = newest(Object.keys(entry.versions), range)
  if (!version)
    throw new Error(
      `${name} has no version in ${range} (published: ${Object.keys(entry.versions).join(', ')})`,
    )
  const v = entry.versions[version] as Version
  const { item } = checkItem(v.item, `${name}@${version} in ${registry}`)
  const dir = versionDir(registry, item.name, version)
  if (hashDir(dir) !== v.sha256)
    throw new Error(`${name}@${version} in ${registry} does not match its sha256`)
  return { ...v, item, dir }
}
