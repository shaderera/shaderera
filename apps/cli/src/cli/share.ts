import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { type Files, scan } from '../project/revisions.ts'
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

  // Only what the site lacks is uploaded; each file is read again and must still be what was hashed.
  const hashes = [...new Set(Object.values(files))]
  const { missing } = (await (
    await call(site, 'POST', '/uploads/missing', { token, json: { hashes } })
  ).json()) as { missing: string[] }
  const pathOf = new Map(Object.entries(files).map(([path, sha]) => [sha, path]))
  await pool(missing, 4, async (sha) => {
    const path = pathOf.get(sha)
    if (!path) throw new Error(`${site} asked for ${sha}, which this project does not have.`)
    const bytes = readFileSync(join(root, path))
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw new Error(`${path} changed during share; share again.`)
    await call(site, 'PUT', `/obj/${sha}`, { token, bytes })
  })

  let target = film
  if (!target) {
    const made = (await (
      await call(site, 'POST', '/films', {
        token,
        json: { title, ...(note.forkedFrom ? { forkedFrom: note.forkedFrom } : {}) },
      })
    ).json()) as { id: string }
    target = made.id
    // Noted at once: if the version fails, the next share retries this film, not another new one.
    writeShareNote(root, site, { ...note, film: target })
  }
  const made = (await (
    await call(site, 'POST', `/films/${encodeURIComponent(target)}/versions`, {
      token,
      json: { files, licence, shaderera: shadereraVersion() },
    })
  ).json()) as { version: string; url?: string }
  // A --film is noted once a version reached it.
  if (target !== readShareNote(root, site).film)
    writeShareNote(root, site, { ...note, film: target })
  const url = made.url ?? `${site}/f/${target}`
  if (v.json)
    console.log(
      JSON.stringify(
        {
          site,
          film: target,
          created: !film,
          version: made.version,
          url,
          files: count,
          bytes,
          uploaded: missing.length,
          notSent: secrets,
        },
        null,
        2,
      ),
    )
  else {
    console.log(
      `shared film ${target} version ${made.version.slice(0, 12)}: ${missing.length} of ${hashes.length} files were new`,
    )
    console.log(`  ${url}`)
  }
  return EXIT.ok
}
