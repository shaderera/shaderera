import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { buildPlayer } from '../player/build.ts'
import { type Files, hashFile, scan, slash } from '../project/revisions.ts'
import { EXIT } from './findings.ts'
import { mediaDir, renderMedia } from './media.ts'
import {
  bytesText,
  call,
  DEFAULT_SITE,
  readShareNote,
  readToken,
  siteOf,
  writeShareNote,
} from './site.ts'

/**
 * What a share sends: the files a revision holds (project/revisions.ts `scan`: no `out/`,
 * `versions/`, `.shaderera/`, `.claude/`, `node_modules/`, `.git/`, links or secrets), and the
 * secrets it leaves out.
 */
export const shareFiles = (root: string): { files: Files; bytes: number; secrets: string[] } => {
  const secrets: string[] = []
  const files = scan(root, { secrets })
  let bytes = 0
  for (const path of Object.keys(files)) bytes += statSync(join(root, path)).size
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

/** The title a new film gets: package.json's name, else the folder's. */
export const titleOf = (root: string): string => {
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
 * version from these (player/build.ts, docs/player.md).
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
 * player (`player`, a folder of built player files; none when left out) and of the poster and
 * loop (`media`, their files), makes the film when there is none yet, and posts `{ files, player,
 * licence, shaderera, poster?, loop? }`. A site that refuses a version without a player says so,
 * and that error is the share's. The url is the film's page: the response's `page`, else
 * shaderera.com's `/film/<film>`, the only film page; never its `url`, which is the player's runner.
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
  media?: { poster?: string; loop?: string }
}): Promise<{ film: string; version: string; url: string; uploaded: number; objects: number }> => {
  const { site, token, root } = o
  const player = o.player ? playerFiles(o.player) : {}
  const media = Object.entries(o.media ?? {}).map(([k, file]) => [k, file, hashFile(file)] as const)
  // Each hash's file on this machine; each is read again and must still be what was hashed.
  const fileOf = new Map<string, readonly [string, string]>([
    ...Object.entries(player).map(([p, sha]) => [sha, [o.player as string, p]] as const),
    ...Object.entries(o.files).map(([p, sha]) => [sha, [root, p]] as const),
    ...media.map(([, file, sha]) => [sha, [dirname(file), basename(file)]] as const),
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
      json: {
        files: o.files,
        player,
        licence: o.licence,
        shaderera: shadereraVersion(),
        ...Object.fromEntries(media.map(([k, , sha]) => [k, sha])),
      },
    })
  ).json()) as { version: string; page?: string }
  // A --film is noted once a version reached it.
  if (film !== readShareNote(root, site).film) writeShareNote(root, site, { ...before, film })
  return {
    film,
    version: made.version,
    url: made.page ?? `${DEFAULT_SITE}/film/${film}`,
    uploaded: missing.length,
    objects: fileOf.size,
  }
}

/** Where `share` builds the player: under `.shaderera/`, which no revision holds. */
export const playerDir = (root: string): string => join(root, '.shaderera', 'player')

/** No token for the site: the person logs in first. Nothing was sent. */
export class LoginNeeded extends Error {}

/**
 * A share, as `shaderera share` and the studio's share button run it: builds the project's web
 * player, says what it will send (`say`), asks (`confirm`; none: send), then sends the project
 * and the player to the site as a new film, or as a new version of the film it shared to before,
 * with a poster and a loop (renderMedia; `media: false`: none). Null when declined. A player that
 * does not build stops it before anything is sent; a poster or loop that does not render is
 * left out, with a warning (`warn`; none: `say`).
 */
export const shareProject = async (o: {
  root: string
  site: string
  film?: string
  title?: string
  say?: (line: string) => void
  warn?: (line: string) => void
  confirm?: () => Promise<boolean>
  media?: boolean
}): Promise<{
  site: string
  film: string
  created: boolean
  version: string
  url: string
  files: number
  bytes: number
  player: { files: number; bytes: number }
  uploaded: number
  objects: number
  notSent: string[]
  /** The poster's and the loop's bytes; null when not sent. */
  poster: number | null
  loop: number | null
  warnings: string[]
} | null> => {
  const { site } = o
  const say = o.say ?? (() => {})
  const project = await findProject(o.root)
  const { root } = project
  const token = readToken(site)
  if (!token)
    throw new LoginNeeded(
      `No token for ${site}: shaderera login --token <token>${site === DEFAULT_SITE ? '' : ` --to ${site}`}`,
    )
  const licence = licenceOf(root)
  const note = readShareNote(root, site)
  const film = o.film ?? note.film
  const title = o.title ?? titleOf(root)
  const { files, bytes, secrets } = shareFiles(root)
  const count = Object.keys(files).length

  // The player is built for this site: only its pages may frame it and get its port.
  const dir = playerDir(root)
  const player = await buildPlayer(project, {
    outDir: dir,
    files: Object.keys(files),
    parents: [site],
  }).catch((e: unknown) => {
    throw new Error(
      `The player did not build: ${e instanceof Error ? e.message : String(e)} Nothing was sent.`,
    )
  })
  say(
    `share: ${count} files, ${bytesText(bytes)}, and a player of ${player.files.length} files, ${bytesText(player.bytes)}, to ${site} as ${film ? `a new version of film ${film}` : `a new film "${title}"${note.forkedFrom ? `, forked from ${note.forkedFrom.slice(0, 12)}` : ''}`} (licence ${licence})`,
  )
  if (secrets.length > 0) say(`  not sent: ${secrets.join(', ')}`)
  if (o.confirm && !(await o.confirm())) return null
  const media = o.media === false ? { warnings: [] } : await renderMedia(root, mediaDir(root))
  for (const w of media.warnings) (o.warn ?? say)(w)
  const size = (file?: string) => (file ? statSync(file).size : null)
  const poster = size(media.poster)
  const loop = size(media.loop)
  const sizes = [
    ...(poster === null ? [] : [`a poster of ${bytesText(poster)}`]),
    ...(loop === null ? [] : [`a loop of ${bytesText(loop)}`]),
  ]
  if (sizes.length > 0) say(`  with ${sizes.join(' and ')}`)

  const sent = await send({
    site,
    token,
    root,
    files,
    licence,
    title,
    ...(film ? { film } : {}),
    ...(note.forkedFrom ? { forkedFrom: note.forkedFrom } : {}),
    player: dir,
    media: {
      ...(media.poster ? { poster: media.poster } : {}),
      ...(media.loop ? { loop: media.loop } : {}),
    },
  })
  return {
    site,
    film: sent.film,
    created: !film,
    version: sent.version,
    url: sent.url,
    files: count,
    bytes,
    player: { files: player.files.length, bytes: player.bytes },
    uploaded: sent.uploaded,
    objects: sent.objects,
    notSent: secrets,
    poster,
    loop,
    warnings: media.warnings,
  }
}

/**
 * `shaderera share [--to <origin>] [--film <id>] [--title <t>] [--no-media] [--yes] [--json]`:
 * shareProject. It prints what it will send and asks first; off a terminal (or with `--json`) it
 * needs `--yes`. It prints the film's page; warnings go to stderr.
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
      'no-media': { type: 'boolean' },
      root: { type: 'string' },
    },
  })
  const site = siteOf(v.to)
  const shared = await shareProject({
    root: v.root ?? process.cwd(),
    site,
    ...(v.film ? { film: v.film } : {}),
    ...(v.title ? { title: v.title } : {}),
    say: (line) => {
      if (!v.json) console.log(line)
    },
    warn: (line) => console.warn(`! ${line}`),
    media: v['no-media'] !== true,
    confirm: async () => {
      if (v.yes) return true
      if (v.json || !process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error('share needs --yes when it is not on a terminal. Nothing was sent.')
      return confirm('Send? [y/N] ')
    },
  })
  if (!shared) {
    console.log('Nothing was sent.')
    return EXIT.failed
  }
  if (v.json) {
    const { objects: _, ...result } = shared
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(
      `shared film ${shared.film} version ${shared.version.slice(0, 12)}: ${shared.uploaded} of ${shared.objects} files were new`,
    )
    console.log(`  ${shared.url}`)
  }
  return EXIT.ok
}
