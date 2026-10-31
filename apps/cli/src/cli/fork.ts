import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { validPath } from '../project/revisions.ts'
import { EXIT } from './findings.ts'
import { pool } from './share.ts'
import { apiOf, bytesText, call, siteOf, writeShareNote } from './site.ts'

type Film = {
  id: string
  title: string
  owner: string
  latestVersion: string | null
  versions: { id: string; licence: string }[]
}

/** Files downloaded at once. */
const DOWNLOADS = 8

/** Where a fork came from: package.json's `forkedFrom`, and a line in its README. */
export type ForkedFrom = {
  film: string
  title: string
  owner: string
  version: string
  licence: string
  page: string
}

/** A licence that keeps every right: the API's "All rights reserved", or npm's UNLICENSED. */
export const reserved = (licence: string): boolean =>
  /^(all rights reserved|unlicensed)$/i.test(licence.trim())

/** The README's line, as share's summary names a film and its licence. */
export const attribution = (f: ForkedFrom): string =>
  `Forked from "${f.title}" by ${f.owner} (${f.page}), version ${f.version}, licence ${f.licence}.`

/** What a fork of a film under `licence` warns, if anything. */
export const licenceNote = (f: ForkedFrom): string | undefined =>
  reserved(f.licence)
    ? `licence ${f.licence}: ${f.owner} keeps every right to "${f.title}". Study it here, but ask them before you share, publish or reuse any of it.`
    : undefined

/**
 * Records the fork in the new project: `forkedFrom` in package.json (when there is one that
 * parses) and a line at the end of README.md (made when there is none). Both are source, so a
 * share sends them and a fork of the fork keeps the line.
 */
const recordFork = (dir: string, f: ForkedFrom): void => {
  const pkg = join(dir, 'package.json')
  if (existsSync(pkg)) {
    try {
      const json = JSON.parse(readFileSync(pkg, 'utf8')) as unknown
      if (json && typeof json === 'object' && !Array.isArray(json))
        writeFileSync(pkg, `${JSON.stringify({ ...json, forkedFrom: f }, null, 2)}\n`)
    } catch {
      // Not JSON: left as the version has it; the README still names the film.
    }
  }
  const readme = join(dir, 'README.md')
  const was = existsSync(readme) ? readFileSync(readme, 'utf8') : `# ${f.title}\n`
  writeFileSync(readme, `${was.trimEnd()}\n\n${attribution(f)}\n`)
}

/**
 * What to fork: a film's id, `<id>@<version>`, or the address of its page on the site (`site`)
 * or on the API itself. A version may be the start of one; the film's latest by default. A page
 * of any other origin is refused rather than looked up on an API it is not from.
 */
export const parseTarget = (
  given: string,
  at: { site: string; api: string },
): { film: string; version?: string } => {
  const url = /^https?:\/\//i.test(given) ? new URL(given) : undefined
  if (url && url.origin !== at.site && url.origin !== at.api)
    throw new Error(
      `${url.origin} is not the site (${at.site}) nor the films API (${at.api}): pass --site <origin> and --api <origin>.`,
    )
  const last = url ? url.pathname.split('/').filter(Boolean).at(-1) : given
  const [film = '', version] = decodeURIComponent(last ?? '').split('@')
  if (!/^[a-z0-9]{1,32}$/.test(film)) throw new Error(`Not a film: ${given}`)
  if (version !== undefined && !/^[0-9a-f]{1,64}$/.test(version))
    throw new Error(`Not a version: ${version}`)
  return { film, ...(version ? { version } : {}) }
}

/**
 * `shaderera fork <film|url>[@version] [dir] [--site <origin>] [--api <origin>] [--json]`: copies a
 * published version from the films API into a new folder (`./<film>` by default) as an ordinary
 * project. Every path is checked as a revision's is, and every file against its sha256, a few
 * downloads at a time. The new project records where it came from (`recordFork`), and a film whose
 * licence keeps every right is forked with a warning. Its first `share` makes a new film, marked
 * as forked from this version.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { site: { type: 'string' }, api: { type: 'string' }, json: { type: 'boolean' } },
  })
  const [given, into, ...extra] = positionals
  if (!given || extra.length > 0)
    throw new Error(
      'Usage: shaderera fork <film|url>[@version] [dir] [--site <origin>] [--api <origin>]',
    )
  const api = apiOf(v.api)
  const site = siteOf(v.site)
  const { film: id, version: wanted } = parseTarget(given, { site, api })

  const film = (await (await call(api, 'GET', `/films/${id}`)).json()) as Film
  const matches = wanted
    ? film.versions.filter((x) => x.id.startsWith(wanted))
    : film.versions.filter((x) => x.id === film.latestVersion)
  const version = matches[0]
  if (!version || matches.length > 1)
    throw new Error(
      !wanted
        ? `${id} has nothing published yet.`
        : matches.length > 1
          ? `${wanted} is the start of more than one version of ${id}: give more of it.`
          : `${id} has no version ${wanted}.`,
    )

  const dir = resolve(into ?? id)
  if (existsSync(dir) && readdirSync(dir).length > 0)
    throw new Error(`${dir} is not empty: fork into a new folder.`)

  const { files } = (await (await call(api, 'GET', `/versions/${version.id}/revision`)).json()) as {
    files: Record<string, string>
  }
  const entries = Object.entries(files)
  const bad = entries.find(([path, sha]) => !validPath(path) || !/^[0-9a-f]{64}$/.test(sha))
  if (bad) throw new Error(`The version names a path or hash a revision may not: ${bad[0]}`)
  if (!files['shaderera.json'])
    throw new Error(`Version ${version.id.slice(0, 12)} has no shaderera.json.`)

  // Everything is fetched and checked before anything is written.
  const bytes = new Map<string, Buffer>()
  await pool([...new Set(entries.map(([, sha]) => sha))], DOWNLOADS, async (sha) => {
    const b = Buffer.from(await (await call(api, 'GET', `/obj/${sha}`)).arrayBuffer())
    if (createHash('sha256').update(b).digest('hex') !== sha)
      throw new Error(`A file from ${api} did not match its sha256 (${sha}); nothing was written.`)
    bytes.set(sha, b)
  })
  let size = 0
  for (const [path, sha] of entries) {
    const to = join(dir, ...path.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    const b = bytes.get(sha) as Buffer
    writeFileSync(to, b)
    size += b.length
  }
  const forkedFrom: ForkedFrom = {
    film: film.id,
    title: film.title,
    owner: film.owner,
    version: version.id,
    licence: version.licence,
    page: `${site}/film/${film.id}`,
  }
  recordFork(dir, forkedFrom)
  writeShareNote(dir, api, { forkedFrom: version.id })
  const note = licenceNote(forkedFrom)

  const result = {
    api,
    dir,
    film: film.id,
    title: film.title,
    owner: film.owner,
    version: version.id,
    licence: version.licence,
    files: entries.length,
    bytes: size,
    forkedFrom,
    warnings: note ? [note] : [],
  }
  if (note) console.warn(`! ${note}`)
  if (v.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(
      `forked "${film.title}" (${film.id}) version ${version.id.slice(0, 12)} into ${dir}: ${entries.length} files, ${bytesText(size)}, licence ${version.licence}`,
    )
    console.log(
      'its code runs with your rights: Shaderera has an execution boundary, not a sandbox. Run it only if you would run its npm run build.',
    )
    console.log('next:')
    console.log(`  cd ${dir}`)
    console.log('  npm install')
    console.log('  npx shaderera check')
    console.log('  npx shaderera share   # a new film, marked as forked from this version')
  }
  return EXIT.ok
}
