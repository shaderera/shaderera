import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { type Files, hashFile, scan, slash } from '../project/revisions.ts'
import { EXIT } from './findings.ts'
import { bytesText, call, readShareNote, readToken, siteOf, writeShareNote } from './site.ts'

/** Files a revision holds that are never sent: secrets, at any depth. */
const SECRET = /^(\.env(\..+)?|\.npmrc)$/

/**
 * What a share sends: the files a revision holds (project/revisions.ts `scan`: no `out/`,
 * `versions/`, `.shaderera/`, `.claude/`, `node_modules/`, `.git/`, links), less secrets.
 */
export const shareFiles = (root: string): { files: Files; bytes: number; secrets: string[] } => {
  const files: Files = {}
  const secrets: string[] = []
  let bytes = 0
  for (const [path, sha] of Object.entries(scan(root))) {
    if (SECRET.test(basename(path))) secrets.push(path)
    else {
      files[path] = sha
      bytes += statSync(join(root, path)).size
    }
  }
  return { files, bytes, secrets }
}

/** The project's licence, as package.json's `license` declares it (UNLICENSED: all rights reserved). */
const licenceOf = (root: string): string => {
  const file = join(root, 'package.json')
  const declared = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { license?: unknown }).license
    : undefined
  if (typeof declared !== 'string' || !declared.trim())
    throw new Error(
      'The project declares no licence: set "license" in package.json (an SPDX id such as MIT, or UNLICENSED for all rights reserved). Nothing was sent.',
    )
  return declared.trim() === 'UNLICENSED' ? 'All rights reserved' : declared.trim()
}

const titleOf = (root: string): string => {
  const file = join(root, 'package.json')
  const name = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name
    : undefined
  return typeof name === 'string' && name.trim() ? name.trim() : basename(root)
}

/** Runs a few at a time. */
const pool = async <T>(items: readonly T[], n: number, run: (item: T) => Promise<void>) => {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item)
    }),
  )
}

const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

/**
 * A built player's files, path → sha256: every file under `dir`, links refused. The site plays a
 * version from these; the engine does not build them yet, so `share` sends none.
 */
export const playerFiles = (dir: string): Files => {
  const files: Files = {}
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = join(e.parentPath, e.name)
    const path = slash(relative(dir, full))
    if (e.isSymbolicLink()) throw new Error(`The player has a link, which is never sent: ${path}`)
    if (e.isFile()) files[path] = hashFile(full)
  }
  return files
}

/**
 * Sends a version: uploads what the site lacks of the source (`files`, under `root`) and of the
 * player (`player`, a folder of built player files; none when left out), makes the film when
 * there is none yet, and posts `{ files, player, licence, shaderera }`. A site that refuses a
 * version without a player says so, and that error is the share's.
 */
export const send = async (o: {
  site: string
  token: string
  root: string
  files: Files
  licence: string
  title: string
  film?: string
  forkedFrom?: string
  player?: string
}): Promise<{ film: string; version: string; url: string; uploaded: number; objects: number }> => {
  const { site, token, root } = o
  const player = o.player ? playerFiles(o.player) : {}
  // Each hash's file on this machine; each is read again and must still be what was hashed.
  const fileOf = new Map<string, readonly [string, string]>([
    ...Object.entries(player).map(([p, sha]) => [sha, [o.player as string, p]] as const),
    ...Object.entries(o.files).map(([p, sha]) => [sha, [root, p]] as const),
  ])
  const { missing } = (await (
    await call(site, 'POST', '/uploads/missing', { token, json: { hashes: [...fileOf.keys()] } })
  ).json()) as { missing: string[] }
  await pool(missing, 4, async (sha) => {
    const at = fileOf.get(sha)
    if (!at) throw new Error(`${site} asked for ${sha}, which this project does not have.`)
    const bytes = readFileSync(join(...at))
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw new Error(`${at[1]} changed during share; share again.`)
    await call(site, 'PUT', `/obj/${sha}`, { token, bytes })
  })

  const before = readShareNote(root, site)
  let film = o.film
  if (!film) {
    const made = (await (
      await call(site, 'POST', '/films', {
        token,
        json: { title: o.title, ...(o.forkedFrom ? { forkedFrom: o.forkedFrom } : {}) },
      })
    ).json()) as { id: string }
    film = made.id
    // Noted at once: if the version fails, the next share retries this film, not another new one.
    writeShareNote(root, site, { ...before, film })
  }
  const made = (await (
    await call(site, 'POST', `/films/${encodeURIComponent(film)}/versions`, {
      token,
      json: { files: o.files, player, licence: o.licence, shaderera: shadereraVersion() },
    })
  ).json()) as { version: string; url?: string }
  // A --film is noted once a version reached it.
  if (film !== readShareNote(root, site).film) writeShareNote(root, site, { ...before, film })
  return {
    film,
    version: made.version,
    url: made.url ?? `${site}/f/${film}`,
    uploaded: missing.length,
    objects: fileOf.size,
  }
}

/**
 * `shaderera share [--to <origin>] [--film <id>] [--title <t>] [--yes] [--json]`: sends the project
 * to the site as a new film, or as a new version of the film it shared to before. It prints what
 * it will send and asks first; off a terminal (or with `--json`) it needs `--yes`.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: {
      to: { type: 'string' },
      film: { type: 'string' },
      title: { type: 'string' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      root: { type: 'string' },
    },
  })
  const site = siteOf(v.to)
  const { root } = await findProject(v.root ?? process.cwd())
  const token = readToken(site)
  if (!token)
    throw new Error(
      `No token for ${site}: shaderera login --token <token>${v.to ? ` --to ${site}` : ''}`,
    )
  const licence = licenceOf(root)
  const note = readShareNote(root, site)
  const film = v.film ?? note.film
  const title = v.title ?? titleOf(root)
  const { files, bytes, secrets } = shareFiles(root)
  const count = Object.keys(files).length

  const say = (line: string) => {
    if (!v.json) console.log(line)
  }
  say(
    `share: ${count} files, ${bytesText(bytes)}, to ${site} as ${film ? `a new version of film ${film}` : `a new film "${title}"${note.forkedFrom ? `, forked from ${note.forkedFrom.slice(0, 12)}` : ''}`} (licence ${licence})`,
  )
  if (secrets.length > 0) say(`  not sent: ${secrets.join(', ')}`)
  if (!v.yes) {
    if (v.json || !process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error('share needs --yes when it is not on a terminal. Nothing was sent.')
    if (!(await confirm('Send? [y/N] '))) {
      console.log('Nothing was sent.')
      return EXIT.failed
    }
  }

  const {
    film: target,
    version,
    url,
    uploaded,
    objects,
  } = await send({
    site,
    token,
    root,
    files,
    licence,
    title,
    ...(film ? { film } : {}),
    ...(note.forkedFrom ? { forkedFrom: note.forkedFrom } : {}),
  })
  if (v.json)
    console.log(
      JSON.stringify(
        {
          site,
          film: target,
          created: !film,
          version,
          url,
          files: count,
          bytes,
          uploaded,
          notSent: secrets,
        },
        null,
        2,
      ),
    )
  else {
    console.log(
      `shared film ${target} version ${version.slice(0, 12)}: ${uploaded} of ${objects} files were new`,
    )
    console.log(`  ${url}`)
  }
  return EXIT.ok
}
