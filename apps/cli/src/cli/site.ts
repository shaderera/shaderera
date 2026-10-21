import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isOrigin } from '../player/parents.ts'

/**
 * What `login`, `share`, `fork` and `studio` share (decision 0019): the two origins they talk to,
 * the token for the API, the project's note of which film it shares to, and the HTTP calls. They
 * run only when called, send nothing in the background and have no telemetry.
 *
 * - **The site** (`--site`, `SHADERERA_SITE`, shaderera.com) is the pages: a film's page, the
 *   studio page and its relay, and the plugins at `<site>/r`.
 * - **The API** (`--api`, `SHADERERA_API`, api.shaderera.com) is the films API (`/api/v1`): where
 *   films are shared from, forked from and signed in to.
 */

export const DEFAULT_SITE = 'https://shaderera.com'
export const DEFAULT_API = 'https://api.shaderera.com'

/** An origin from a flag, else an env var, else the default. Plain http only for this machine. */
const originOf = (flag: string, given: string): string => {
  let url: URL
  try {
    url = new URL(given)
  } catch {
    throw new Error(`Not an origin: ${given} (${flag} takes one, such as https://example.com).`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error(`${url.origin}: ${flag} is reached over https (http only on this machine).`)
  return url.origin
}

/** The site's origin: `--site <origin>`, else `SHADERERA_SITE`, else shaderera.com. */
export const siteOf = (given?: string): string =>
  originOf('--site', given ?? process.env.SHADERERA_SITE ?? DEFAULT_SITE)

/**
 * The films API's origin: `--api <origin>`, else `SHADERERA_API`, else api.shaderera.com. Plain
 * http only for this machine, since a token goes with every write.
 */
export const apiOf = (given?: string): string =>
  originOf('--api', given ?? process.env.SHADERERA_API ?? DEFAULT_API)

/** ` --api <api>` when it is not the default: what a hint adds to a command. */
export const apiFlag = (api: string): string => (api === DEFAULT_API ? '' : ` --api ${api}`)

/** How to sign in to `api`: what an error adds, once (the API's own 401s name no command). */
export const signInHint = (api: string): string => `Sign in: npx shaderera login${apiFlag(api)}`

/**
 * The client id of Shaderera's GitHub OAuth App, which `login` signs in with (GitHub's device
 * flow). It is public, and the owner fills it in once the App exists (under the shaderera org,
 * Device Flow enabled). While it is empty, `login` without `--token` says so and stops;
 * `SHADERERA_GITHUB_CLIENT_ID` overrides it.
 */
export const GITHUB_CLIENT_ID = ''

/** Where tokens are kept, one per API: `~/.shaderera/tokens.json`, readable by its owner only. */
export const tokensFile = (): string => join(homedir(), '.shaderera', 'tokens.json')

const readTokens = (): Record<string, string> =>
  existsSync(tokensFile()) ? JSON.parse(readFileSync(tokensFile(), 'utf8')) : {}

export const readToken = (api: string): string | undefined => readTokens()[api]

export const saveToken = (api: string, token: string): string => {
  const file = tokensFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ ...readTokens(), [api]: token }, null, 2)}
`,
    {
      mode: 0o600,
    },
  )
  return file
}

/** Forgets the token for `api`: false when there was none. */
export const removeToken = (api: string): boolean => {
  const tokens = readTokens()
  if (!(api in tokens)) return false
  delete tokens[api]
  writeFileSync(
    tokensFile(),
    `${JSON.stringify(tokens, null, 2)}
`,
    { mode: 0o600 },
  )
  return true
}

/**
 * The project's note of where it is shared, per API: the film it sends new versions to, and the
 * version it was forked from until its first share. It is in `.shaderera/`, which a revision never
 * holds, so a share never sends it and a fork never inherits it.
 */
export type ShareNote = { film?: string; forkedFrom?: string }
export const shareFile = (root: string): string => join(root, '.shaderera', 'share.json')

export const readShareNote = (root: string, api: string): ShareNote => {
  const file = shareFile(root)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8'))[api] ?? {}) : {}
}

export const writeShareNote = (root: string, api: string, note: ShareNote): void => {
  const file = shareFile(root)
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ ...all, [api]: note }, null, 2)}
`,
  )
}

/**
 * What an answer that is not the API's JSON error says, for a person: its first line, at most 120
 * characters. A proxy's or a site's HTML page is never printed whole.
 */
export const firstLine = (text: string): string => {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * One call to the films API (`/api/v1/...`): JSON in and out, or bytes. The token, when given,
 * goes in the Authorization header and nowhere else; an error names the call, the status and the
 * API's own message (an answer that is not JSON: its first line).
 */
export const call = async (
  api: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  o: { token?: string; json?: unknown; bytes?: Uint8Array } = {},
): Promise<Response> => {
  const headers: Record<string, string> = {}
  if (o.token) headers.Authorization = `Bearer ${o.token}`
  if (o.json !== undefined) headers['Content-Type'] = 'application/json'
  if (o.bytes) headers['Content-Type'] = 'application/octet-stream'
  const body = o.json !== undefined ? JSON.stringify(o.json) : o.bytes
  let r: Response
  try {
    r = await fetch(`${api}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    })
  } catch (e) {
    throw new Error(`${api} cannot be reached: ${(e as Error).message}`)
  }
  if (r.ok) return r
  const text = await r.text()
  let message: string
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error
    message = typeof error === 'string' ? error : firstLine(text)
  } catch {
    message = `(not the films API's answer) ${firstLine(text)}`.trim()
  }
  const login = r.status === 401 ? ` ${signInHint(api)}` : ''
  // A 429 says when a retry can pass.
  const retry = Number(r.headers.get('Retry-After'))
  const later = r.status === 429 && retry > 0 ? ` Try again in ${Math.ceil(retry)} s.` : ''
  throw new Error(`${method} ${path} on ${api}: ${r.status} ${message}${login}${later}`)
}

/**
 * The upload limits a films API names in its health (shaderera.com API.md, "Limits"): bytes a file
 * and a version, files a version, hashes one `POST /uploads/missing`, a poster's and a loop's
 * bytes. Each is a positive number, or absent when the API does not name it.
 */
export type Limits = Partial<
  Record<
    'fileBytes' | 'versionBytes' | 'filesPerVersion' | 'hashesPerAsk' | 'posterBytes' | 'loopBytes',
    number
  >
>
const LIMIT_NAMES = [
  'fileBytes',
  'versionBytes',
  'filesPerVersion',
  'hashesPerAsk',
  'posterBytes',
  'loopBytes',
] as const

/**
 * What the API's health (`GET /api/v1/films/health`, read without a token) says a share needs:
 * `parents`, the origins that may frame a shared film's player and get its port (the site that
 * shows its films), and `limits`, which a share checks before it uploads. An API without them, or
 * that does not answer, names none; an entry that is not an origin, or a limit that is not a
 * positive number, is left out.
 */
export const healthOf = async (api: string): Promise<{ parents: string[]; limits: Limits }> => {
  try {
    const r = await fetch(`${api}/api/v1/films/health`)
    if (!r.ok) return { parents: [], limits: {} }
    const { parents, limits } = (await r.json()) as { parents?: unknown; limits?: unknown }
    const given = (limits && typeof limits === 'object' ? limits : {}) as Record<string, unknown>
    return {
      parents: Array.isArray(parents)
        ? parents.filter((p): p is string => typeof p === 'string' && isOrigin(p))
        : [],
      limits: Object.fromEntries(
        LIMIT_NAMES.flatMap((k) => {
          const n = given[k]
          return typeof n === 'number' && Number.isFinite(n) && n > 0 ? [[k, n]] : []
        }),
      ),
    }
  } catch {
    return { parents: [], limits: {} }
  }
}

/** Opens `url` in the person's default browser; a failure to is only a missed convenience. */
export const openBrowser = (url: string) => {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}

/** `n` bytes for a person: 1.2 MB, 340 KB, 12 B. */
export const bytesText = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
