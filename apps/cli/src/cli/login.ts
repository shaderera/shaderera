import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { call, DEFAULT_SITE, GITHUB_CLIENT_ID, saveToken, siteOf } from './site.ts'

/** GitHub's device flow endpoints (docs.github.com, "Authorizing OAuth apps", device flow). */
export type GitHubEndpoints = { deviceCode: string; accessToken: string }
export const GITHUB: GitHubEndpoints = {
  deviceCode: 'https://github.com/login/device/code',
  accessToken: 'https://github.com/login/oauth/access_token',
}

/** What `login` uses from outside, so tests can pass a local GitHub, a fast clock and no browser. */
export type LoginDeps = {
  github: GitHubEndpoints
  /** The OAuth App's client id built into the CLI; `SHADERERA_GITHUB_CLIENT_ID` overrides it. */
  clientId: string
  open: (url: string) => void
  sleep: (seconds: number) => Promise<void>
}

/** Opens `url` in the person's default browser; a failure to is only a missed convenience. */
const openBrowser = (url: string) => {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}

const defaults: LoginDeps = {
  github: GITHUB,
  clientId: GITHUB_CLIENT_ID,
  open: openBrowser,
  sleep: (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)),
}

/** A form POST to GitHub, answered as JSON (GitHub answers form-encoded without the Accept). */
const ask = async (url: string, form: Record<string, string>): Promise<Record<string, unknown>> => {
  let r: Response
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
  } catch (e) {
    throw new Error(`GitHub cannot be reached: ${(e as Error).message}`)
  }
  let body: unknown
  try {
    body = await r.json()
  } catch {
    body = undefined
  }
  if (!body || typeof body !== 'object') throw new Error(`GitHub answered ${r.status}, not JSON.`)
  const b = body as Record<string, unknown>
  if (!r.ok && typeof b.error !== 'string') throw new Error(`GitHub answered ${r.status}.`)
  return b
}

const refused = (b: Record<string, unknown>) =>
  new Error(
    `GitHub refused the sign-in: ${typeof b.error_description === 'string' ? b.error_description : b.error}`,
  )

/**
 * GitHub's device flow: asks for a code (no scope: the public profile only), shows it and opens
 * the page to enter it, then polls at GitHub's interval until the person approves. Returns the
 * GitHub token, which the caller sends once to the site and never keeps.
 */
const deviceFlow = async (
  deps: LoginDeps,
  clientId: string,
  noOpen: boolean,
  say: (line: string) => void,
): Promise<string> => {
  const code = await ask(deps.github.deviceCode, { client_id: clientId })
  if (typeof code.error === 'string') throw refused(code)
  const { device_code: device, user_code: user, verification_uri: page } = code
  if (typeof device !== 'string' || typeof user !== 'string' || typeof page !== 'string')
    throw new Error('GitHub sent no device code.')
  let interval = typeof code.interval === 'number' ? code.interval : 5
  const expiresIn = typeof code.expires_in === 'number' ? code.expires_in : 900
  say(`Enter the code ${user} at ${page}`)
  if (!noOpen) {
    say(`opening ${page}`)
    deps.open(page)
  }
  const expired = new Error('The code expired before it was entered; run shaderera login again.')
  for (let waited = 0; ; ) {
    if (waited >= expiresIn) throw expired
    await deps.sleep(interval)
    waited += interval
    const r = await ask(deps.github.accessToken, {
      client_id: clientId,
      device_code: device,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (typeof r.access_token === 'string' && r.access_token) return r.access_token
    if (r.error === 'authorization_pending') continue
    if (r.error === 'slow_down') {
      // GitHub sends the new interval; it is the old one plus 5 seconds.
      interval = typeof r.interval === 'number' ? r.interval : interval + 5
      continue
    }
    if (r.error === 'expired_token') throw expired
    if (r.error === 'access_denied') throw new Error('The sign-in was declined on GitHub.')
    throw refused(r)
  }
}

/**
 * `shaderera login [--to <origin>] [--no-open]`: signs in with GitHub (the device flow), swaps the
 * GitHub token once at the site's `POST /api/v1/auth/github` for the site's own token, and keeps
 * that one for `share`. `shaderera login --token <token> [--to <origin>]` keeps a token given by
 * hand. No token, GitHub's or the site's, is ever printed or written anywhere but the token file.
 */
export const run = async (argv: readonly string[], deps: LoginDeps = defaults): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: { token: { type: 'string' }, to: { type: 'string' }, 'no-open': { type: 'boolean' } },
  })
  const site = siteOf(v.to)
  if (v.token !== undefined) {
    const token = v.token.trim()
    if (!token) throw new Error('Usage: shaderera login [--token <token>] [--to <origin>]')
    console.log(`token for ${site} saved in ${saveToken(site, token)}`)
    return 0
  }
  const clientId = process.env.SHADERERA_GITHUB_CLIENT_ID?.trim() || deps.clientId
  if (!clientId) throw new Error("GitHub sign-in isn't configured yet; use --token")
  const github = await deviceFlow(deps, clientId, v['no-open'] === true, (l) => console.log(l))
  const r = await call(site, 'POST', '/auth/github', { json: { token: github } })
  const signed = (await r.json()) as { token?: unknown; handle?: unknown }
  if (typeof signed.token !== 'string' || !signed.token || typeof signed.handle !== 'string')
    throw new Error(`${site} sent no token for the sign-in.`)
  saveToken(site, signed.token)
  console.log(`Signed in as ${signed.handle}${site === DEFAULT_SITE ? '' : ` on ${site}`}`)
  return 0
}
