import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * What `login`, `share` and `fork` share (decision 0019): which site they talk to, the token for
 * it, the project's note of which film it shares to, and the HTTP calls. They run only when
 * called, send nothing in the background and have no telemetry.
 */

export const DEFAULT_SITE = 'https://shaderera.com'

/**
 * The client id of Shaderera's GitHub OAuth App, which `login` signs in with (the device flow). It
 * is public. Empty until the App exists: `login` then needs `--token`, or
 * `SHADERERA_GITHUB_CLIENT_ID`.
 */
export const GITHUB_CLIENT_ID = ''

/** How to sign in to `site`: `npx shaderera login`, with `--to` for a site other than the default. */
export const signInHint = (site: string): string =>
  `Sign in: npx shaderera login${site === DEFAULT_SITE ? '' : ` --to ${site}`}`

/**
 * The site's origin: `--to <origin>`, else `SHADERERA_SITE`, else shaderera.com. Plain http only
 * for this machine, since a token goes with every write.
 */
export const siteOf = (to?: string): string => {
  const given = to ?? process.env.SHADERERA_SITE ?? DEFAULT_SITE
  let url: URL
  try {
    url = new URL(given)
  } catch {
    throw new Error(`Not a site's address: ${given} (an origin such as ${DEFAULT_SITE}).`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error(`${url.origin}: a site is reached over https (http only on this machine).`)
  return url.origin
}

/** Where tokens are kept, one per site: `~/.shaderera/tokens.json`, readable by its owner only. */
export const tokensFile = (): string => join(homedir(), '.shaderera', 'tokens.json')

const readTokens = (): Record<string, string> =>
  existsSync(tokensFile()) ? JSON.parse(readFileSync(tokensFile(), 'utf8')) : {}

export const readToken = (site: string): string | undefined => readTokens()[site]

export const saveToken = (site: string, token: string): string => {
  const file = tokensFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...readTokens(), [site]: token }, null, 2)}\n`, {
    mode: 0o600,
  })
  return file
}

/**
 * The project's note of where it is shared, per site: the film it sends new versions to, and the
 * version it was forked from until its first share. It is in `.shaderera/`, which a revision never
 * holds, so a share never sends it and a fork never inherits it.
 */
export type ShareNote = { film?: string; forkedFrom?: string }
export const shareFile = (root: string): string => join(root, '.shaderera', 'share.json')

export const readShareNote = (root: string, site: string): ShareNote => {
  const file = shareFile(root)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8'))[site] ?? {}) : {}
}

export const writeShareNote = (root: string, site: string, note: ShareNote): void => {
  const file = shareFile(root)
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...all, [site]: note }, null, 2)}\n`)
}

/**
 * One call to the site's API (`/api/v1/...`): JSON in and out, or bytes. The token, when given,
 * goes in the Authorization header and nowhere else; an error names the call, the status and the
 * site's own message.
 */
export const call = async (
  site: string,
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
    r = await fetch(`${site}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    })
  } catch (e) {
    throw new Error(`${site} cannot be reached: ${(e as Error).message}`)
  }
  if (r.ok) return r
  const text = await r.text()
  let message = text.trim()
  try {
    message = (JSON.parse(text) as { error?: string }).error ?? message
  } catch {}
  const login =
    r.status === 401 && !message.includes('npx shaderera login') ? ` ${signInHint(site)}` : ''
  throw new Error(`${method} ${path} on ${site}: ${r.status} ${message}${login}`)
}

/** `n` bytes for a person: 1.2 MB, 340 KB, 12 B. */
export const bytesText = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
