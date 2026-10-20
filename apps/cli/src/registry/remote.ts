import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NAME } from './item.ts'
import { parseVersion } from './semver.ts'
import {
  folderName,
  hashDir,
  type Index,
  newest,
  parseSpec,
  versionDir,
  writeWhole,
} from './store.ts'

export const isUrl = (registry: string): boolean => /^https?:\/\//i.test(registry)

/** Where a registry served at `url` is mirrored: one folder per URL. */
export const cacheDir = (url: string): string =>
  join(
    process.env.SHADERERA_CACHE ?? join(homedir(), '.shaderera', 'cache'),
    createHash('sha256').update(url).digest('hex').slice(0, 16),
  )

const get = async (url: string): Promise<Buffer> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

/** The versions `spec` resolves to and every item and extension it requires, each once. */
const closure = (index: Index, spec: string): [string, string][] => {
  const out: [string, string][] = []
  const seen = new Set<string>()
  const visit = (want: string) => {
    const { name, range } = parseSpec(want)
    const entry = index.items[name]
    if (seen.has(name) || !entry) return
    seen.add(name)
    const version = newest(Object.keys(entry.versions), range)
    const v = version ? entry.versions[version] : undefined
    if (!version || !v) return
    out.push([name, version])
    const { extensions, items } = v.item.requires
    for (const [n, r] of [...Object.entries(extensions ?? {}), ...Object.entries(items ?? {})])
      visit(`${n}@${r}`)
  }
  visit(spec)
  return out
}

/** The versions a command reads files of: the rest only needs the index and search.json. */
const wanted = (index: Index, command: string, args: readonly string[]): [string, string][] => {
  if ((command === 'add' || command === 'info') && args[0]) return closure(index, args[0])
  return []
}

/**
 * Mirrors the registry served at `url` into a local folder and returns it, so every command reads
 * a folder as before: `index.json` and `search.json` each time, and the files of the versions
 * `command` reads unless the folder already has them. A path in the index never leaves the
 * version's folder, and `resolve` still checks the files against the sha256 the index records.
 * Offline, the last mirror is used.
 */
export const mirror = async (
  url: string,
  command: string,
  args: readonly string[],
): Promise<string> => {
  const base = url.replace(/\/+$/, '')
  const dir = cacheDir(base)
  mkdirSync(dir, { recursive: true })
  let indexText: Buffer
  try {
    indexText = await get(`${base}/index.json`)
    writeWhole(join(dir, 'search.json'), await get(`${base}/search.json`))
    writeWhole(join(dir, 'index.json'), indexText)
  } catch (e) {
    if (!existsSync(join(dir, 'index.json'))) throw e
    console.error(`shaderera: ${(e as Error).message}; using the copy from last time`)
    return dir
  }
  const index: Index = JSON.parse(indexText.toString('utf8'))
  for (const [name, version] of wanted(index, command, args)) {
    const v = index.items[name]?.versions[version]
    if (!v || !NAME.test(name) || !parseVersion(version)) continue
    const target = versionDir(dir, name, version)
    if (existsSync(target) && hashDir(target) === v.sha256) continue
    if (!v.files) throw new Error(`${name}@${version} at ${base} lists no files; republish it`)
    // Named by the process: another command mirroring the same version fills its own.
    const partial = `${target}.${process.pid}.partial`
    rmSync(partial, { recursive: true, force: true })
    for (const f of v.files) {
      if (
        f.startsWith('/') ||
        f.split(/[/\\]/).some((s) => s === '..' || s === '' || s.includes(':'))
      )
        throw new Error(`${name}@${version} at ${base} lists a file outside its folder: ${f}`)
      const path = join(partial, f)
      mkdirSync(join(path, '..'), { recursive: true })
      const remote = f.split('/').map(encodeURIComponent).join('/')
      writeFileSync(path, await get(`${base}/items/${folderName(name)}/${version}/${remote}`))
    }
    rmSync(target, { recursive: true, force: true })
    try {
      renameSync(partial, target)
    } catch (e) {
      // Another command placed the same version first.
      rmSync(partial, { recursive: true, force: true })
      if (!existsSync(target) || hashDir(target) !== v.sha256) throw e
    }
  }
  return dir
}
