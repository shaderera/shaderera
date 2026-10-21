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
  apiOf,
  bytesText,
  call,
  healthOf,
  type Limits,
  readShareNote,
  readToken,
  signInHint,
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
export const licenceOf = (root: string): string => {
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
 * Sends a version to the films API: uploads what it lacks of the source (`files`, under `root`) and of the
 * player (`player`, a folder of built player files; none when left out) and of the poster and
 * loop (`media`, their files), makes the film when there is none yet, and posts `{ files, player,
 * licence, shaderera, poster?, loop? }`. An API that refuses a version without a player says so,
 * and that error is the share's. The url is the film's page: the response's `page`, else the
 * site's `/film/<film>`, the only film page; never its `url`, which is the player's runner.
 */
export const send = async (o: {
  api: string
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
  /** The most hashes one `POST /uploads/missing` may ask about (the API's `hashesPerAsk`). */
  hashesPerAsk?: number
}): Promise<{ film: string; version: string; url: string; uploaded: number; objects: number }> => {
  const { api, token, root } = o
  const player = o.player ? playerFiles(o.player) : {}
  const media = Object.entries(o.media ?? {}).map(([k, file]) => [k, file, hashFile(file)] as const)
  // Each hash's file on this machine; each is read again and must still be what was hashed.
  const fileOf = new Map<string, readonly [string, string]>([
    ...Object.entries(player).map(([p, sha]) => [sha, [o.player as string, p]] as const),
    ...Object.entries(o.files).map(([p, sha]) => [sha, [root, p]] as const),
    ...media.map(([, file, sha]) => [sha, [dirname(file), basename(file)]] as const),
  ])
  // Asked in batches of at most hashesPerAsk (2,000, the API's own, when it names none).
  const hashes = [...fileOf.keys()]
  const batch = o.hashesPerAsk ?? 2000
  const missing: string[] = []
  for (let i = 0; i < hashes.length; i += batch) {
    const asked = (await (
      await call(api, 'POST', '/uploads/missing', {
        token,
        json: { hashes: hashes.slice(i, i + batch) },
      })
    ).json()) as { missing: string[] }
    missing.push(...asked.missing)
  }
  await pool(missing, 4, async (sha) => {
    const at = fileOf.get(sha)
    if (!at) throw new Error(`${api} asked for ${sha}, which this project does not have.`)
    const bytes = readFileSync(join(...at))
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw new Error(`${at[1]} changed during share; share again.`)
    await call(api, 'PUT', `/obj/${sha}`, { token, bytes })
  })

  const before = readShareNote(root, api)
  let film = o.film
  if (!film) {
    const made = (await (
      await call(api, 'POST', '/films', {
        token,
        json: { title: o.title, ...(o.forkedFrom ? { forkedFrom: o.forkedFrom } : {}) },
      })
    ).json()) as { id: string }
    film = made.id
    // Noted at once: if the version fails, the next share retries this film, not another new one.
    writeShareNote(root, api, { ...before, film })
  }
  const made = (await (
    await call(api, 'POST', `/films/${encodeURIComponent(film)}/versions`, {
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
  if (film !== readShareNote(root, api).film) writeShareNote(root, api, { ...before, film })
  return {
    film,
    version: made.version,
    url: made.page ?? `${o.site}/film/${film}`,
    uploaded: missing.length,
    objects: fileOf.size,
  }
}

/** Where `share` builds the player: under `.shaderera/`, which no revision holds. */
export const playerDir = (root: string): string => join(root, '.shaderera', 'player')

/** No token for the API: the person logs in first. Nothing was sent. */
export class LoginNeeded extends Error {}

/** The host flags a share's poster and loop render with: `--host`, `--trusted`, `--timeout`. */
export type HostFlags = { host?: unknown; trusted?: unknown; timeout?: unknown }

/** One object a version would send: its path (`player/…`, `poster`, `loop` beyond the source's). */
type Sized = { path: string; sha: string; bytes: number }

/**
 * What a version would break of the API's limits (healthOf), one sentence each; none when it
 * fits or the API names none. Files a version are its source's and its player's together; its
 * bytes are each distinct object's once, as the API counts them.
 */
export const overLimits = (
  limits: Limits,
  v: { objects: readonly Sized[]; files: number; poster: Sized | null; loop: Sized | null },
): string[] => {
  const over: string[] = []
  const all = [...v.objects, ...[v.poster, v.loop].filter((x): x is Sized => x !== null)]
  if (limits.fileBytes !== undefined) {
    const max = limits.fileBytes
    const big = all.filter((x) => x.bytes > max)
    for (const x of big.slice(0, 3))
      over.push(`${x.path} is ${bytesText(x.bytes)}, over the ${bytesText(max)} a file may be`)
    if (big.length > 3) over.push(`and ${big.length - 3} more files over ${bytesText(max)}`)
  }
  const total = [...new Map(all.map((x) => [x.sha, x.bytes])).values()].reduce((a, b) => a + b, 0)
  if (limits.versionBytes !== undefined && total > limits.versionBytes)
    over.push(
      `the version is ${bytesText(total)}, over the ${bytesText(limits.versionBytes)} a version may be`,
    )
  if (limits.filesPerVersion !== undefined && v.files > limits.filesPerVersion)
    over.push(
      `the version has ${v.files} files (source and player), over the ${limits.filesPerVersion} a version may have`,
    )
  if (v.poster && limits.posterBytes !== undefined && v.poster.bytes > limits.posterBytes)
    over.push(
      `the poster is ${bytesText(v.poster.bytes)}, over the ${bytesText(limits.posterBytes)} a poster may be`,
    )
  if (v.loop && limits.loopBytes !== undefined && v.loop.bytes > limits.loopBytes)
    over.push(
      `the loop is ${bytesText(v.loop.bytes)}, over the ${bytesText(limits.loopBytes)} a loop may be`,
    )
  return over
}

/** The objects of a version as `share` would send them: the source's and the built player's. */
const objectsOf = (root: string, files: Files, dir: string): Sized[] => [
  ...Object.entries(files).map(([path, sha]) => ({
    path,
    sha,
    bytes: statSync(join(root, path)).size,
  })),
  ...Object.entries(playerFiles(dir)).map(([path, sha]) => ({
    path: `player/${path}`,
    sha,
    bytes: statSync(join(dir, path)).size,
  })),
]

/** What a share or a dry run says and does, given to shareProject and dryRunShare. */
type ShareOptions = {
  root: string
  /** The films API it sends to. */
  api: string
  /** The site whose pages show the film: the player's parent when the API names none. */
  site: string
  film?: string
  title?: string
  say?: (line: string) => void
  warn?: (line: string) => void
  media?: boolean
  /** The poster's and loop's render: `--host`, `--trusted`, `--timeout`. */
  hostFlags?: HostFlags
}

/**
 * The part a share and a dry run have in common: checks the project (a licence, the files a
 * revision holds), then the token unless `needToken` is false, reads the API's health (parents,
 * limits), builds the player for those parents (else the site alone) and says what it will send.
 */
const prepare = async (o: ShareOptions, needToken: boolean) => {
  const { api, site } = o
  const say = o.say ?? (() => {})
  const project = await findProject(o.root)
  const { root } = project
  const licence = licenceOf(root)
  const { files, bytes, secrets } = shareFiles(root)
  const token = readToken(api)
  if (!token && needToken) throw new LoginNeeded(`No token for ${api}. ${signInHint(api)}`)
  const note = readShareNote(root, api)
  const film = o.film ?? note.film
  const title = o.title ?? titleOf(root)
  const count = Object.keys(files).length

  // The player is built for the pages the API names (the site that shows its films), else for the
  // site alone: only they may frame it and get its port.
  const health = await healthOf(api)
  const parents = health.parents.length > 0 ? [...new Set(health.parents)] : [site]
  const dir = playerDir(root)
  const player = await buildPlayer(project, {
    outDir: dir,
    files: Object.keys(files),
    parents,
  }).catch((e: unknown) => {
    throw new Error(
      `The player did not build: ${e instanceof Error ? e.message : String(e)} Nothing was sent.`,
    )
  })
  say(
    `share: ${count} files, ${bytesText(bytes)}, and a player of ${player.files.length} files, ${bytesText(player.bytes)}, to ${api} as ${film ? `a new version of film ${film}` : `a new film "${title}"${note.forkedFrom ? `, forked from ${note.forkedFrom.slice(0, 12)}` : ''}`} (licence ${licence})`,
  )
  say(`  the player plays on ${parents.join(', ')}`)
  if (secrets.length > 0) say(`  not sent: ${secrets.join(', ')}`)
  return {
    root,
    token,
    licence,
    note,
    film,
    title,
    files,
    bytes,
    secrets,
    count,
    parents,
    limits: health.limits,
    dir,
    player,
  }
}

/**
 * Renders the poster and the loop (renderMedia with the host flags; `media: false`: none), says
 * their sizes, and checks the version against the API's limits.
 */
const finish = async (o: ShareOptions, p: Awaited<ReturnType<typeof prepare>>) => {
  const say = o.say ?? (() => {})
  const media =
    o.media === false
      ? { warnings: [] }
      : await renderMedia(p.root, mediaDir(p.root), o.hostFlags ?? {})
  for (const w of media.warnings) (o.warn ?? say)(w)
  const sized = (path: string, file?: string): Sized | null =>
    file ? { path, sha: hashFile(file), bytes: statSync(file).size } : null
  const poster = sized('poster', media.poster)
  const loop = sized('loop', media.loop)
  const sizes = [
    ...(poster === null ? [] : [`a poster of ${bytesText(poster.bytes)}`]),
    ...(loop === null ? [] : [`a loop of ${bytesText(loop.bytes)}`]),
  ]
  if (sizes.length > 0) say(`  with ${sizes.join(' and ')}`)
  const over = overLimits(p.limits, {
    objects: objectsOf(p.root, p.files, p.dir),
    files: p.count + p.player.files.length,
    poster,
    loop,
  })
  return { media, poster, loop, over }
}

/**
 * A share, as `shaderera share` and the studio's share button run it: prepares (the licence and
 * files, the token, the API's parents and limits, the player), asks (`confirm`; none: send),
 * renders the poster and loop, refuses a version over the API's limits, then sends the project
 * and the player to the API as a new film, or as a new version of the film it shared to before.
 * Null when declined. A player that does not build, or a version over a limit, stops it before
 * anything is sent; a poster or loop that does not render is left out, with a warning (`warn`;
 * none: `say`).
 */
export const shareProject = async (
  o: ShareOptions & { confirm?: () => Promise<boolean> },
): Promise<{
  api: string
  film: string
  created: boolean
  version: string
  url: string
  files: number
  bytes: number
  player: { files: number; bytes: number }
  /** The origins that may frame the player and get its port. */
  parents: string[]
  uploaded: number
  objects: number
  notSent: string[]
  /** The poster's and the loop's bytes; null when not sent. */
  poster: number | null
  loop: number | null
  warnings: string[]
} | null> => {
  const p = await prepare(o, true)
  if (o.confirm && !(await o.confirm())) return null
  const { media, poster, loop, over } = await finish(o, p)
  if (over.length > 0)
    throw new Error(`Over the limits of ${o.api}: ${over.join('; ')}. Nothing was sent.`)

  const sent = await send({
    api: o.api,
    site: o.site,
    token: p.token as string,
    root: p.root,
    files: p.files,
    licence: p.licence,
    title: p.title,
    ...(p.film ? { film: p.film } : {}),
    ...(p.note.forkedFrom ? { forkedFrom: p.note.forkedFrom } : {}),
    player: p.dir,
    media: {
      ...(media.poster ? { poster: media.poster } : {}),
      ...(media.loop ? { loop: media.loop } : {}),
    },
    ...(p.limits.hashesPerAsk ? { hashesPerAsk: p.limits.hashesPerAsk } : {}),
  })
  return {
    api: o.api,
    film: sent.film,
    created: !p.film,
    version: sent.version,
    url: sent.url,
    files: p.count,
    bytes: p.bytes,
    player: { files: p.player.files.length, bytes: p.player.bytes },
    parents: p.parents,
    uploaded: sent.uploaded,
    objects: sent.objects,
    notSent: p.secrets,
    poster: poster?.bytes ?? null,
    loop: loop?.bytes ?? null,
    warnings: media.warnings,
  }
}

/**
 * `share --dry-run`: everything a share does on this machine, and nothing it sends. It needs no
 * token (it says whether there is one), builds the player, renders the poster and loop, and names
 * each limit of the API's the version would break.
 */
export const dryRunShare = async (o: ShareOptions) => {
  const p = await prepare(o, false)
  const { media, poster, loop, over } = await finish(o, p)
  return {
    dryRun: true as const,
    api: o.api,
    signedIn: p.token !== undefined,
    film: p.film ?? null,
    title: p.title,
    licence: p.licence,
    files: p.count,
    bytes: p.bytes,
    player: { files: p.player.files.length, bytes: p.player.bytes },
    parents: p.parents,
    notSent: p.secrets,
    poster: poster?.bytes ?? null,
    loop: loop?.bytes ?? null,
    warnings: media.warnings,
    limits: p.limits,
    over,
  }
}

/**
 * `shaderera share [--api <origin>] [--site <origin>] [--film <id>] [--title <t>] [--no-media]
 * [--dry-run] [--host h] [--trusted] [--timeout s] [--yes] [--json]`: shareProject. It prints what
 * it will send and asks first; off a terminal (or with `--json`) it needs `--yes`. It prints the
 * film's page; warnings go to stderr. `--dry-run` is dryRunShare: it sends nothing, needs no
 * token, and exits 1 when the version is over a limit of the API's.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: {
      api: { type: 'string' },
      site: { type: 'string' },
      film: { type: 'string' },
      title: { type: 'string' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-media': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      root: { type: 'string' },
      host: { type: 'string' },
      trusted: { type: 'boolean' },
      timeout: { type: 'string' },
    },
  })
  const options = {
    root: v.root ?? process.cwd(),
    api: apiOf(v.api),
    site: siteOf(v.site),
    ...(v.film ? { film: v.film } : {}),
    ...(v.title ? { title: v.title } : {}),
    say: (line: string) => {
      if (!v.json) console.log(line)
    },
    warn: (line: string) => console.warn(`! ${line}`),
    media: v['no-media'] !== true,
    hostFlags: { host: v.host, trusted: v.trusted, timeout: v.timeout },
  }
  if (v['dry-run']) {
    const plan = await dryRunShare(options)
    if (v.json) console.log(JSON.stringify(plan, null, 2))
    else {
      if (!plan.signedIn) console.log(`  not signed in to ${plan.api}: ${signInHint(plan.api)}`)
      for (const o of plan.over) console.log(`  over: ${o}`)
      console.log(
        plan.over.length > 0
          ? `Nothing was sent (--dry-run); a share would be refused: ${plan.over.length} over the limits of ${plan.api}.`
          : 'Nothing was sent (--dry-run).',
      )
    }
    return plan.over.length > 0 ? EXIT.failed : EXIT.ok
  }
  const shared = await shareProject({
    ...options,
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
