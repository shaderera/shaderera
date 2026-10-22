import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import {
  apiFlag,
  apiOf,
  call,
  DEFAULT_API,
  GITHUB_CLIENT_ID,
  openBrowser,
  saveToken,
} from './site.ts'

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
  /** This machine's name, as the API keeps it beside its token. */
  machine: () => string
}

/**
 * This machine's name for the API: the host name, without control characters, trimmed, at most
 * 64 characters (the API's rule); `this machine` when nothing is left.
 */
export const machineName = (name = hostname()): string =>
  [...name.replace(/\p{Cc}/gu, '')].slice(0, 64).join('').trim() || 'this machine'

const defaults: LoginDeps = {
  github: GITHUB,
  clientId: GITHUB_CLIENT_ID,
  open: openBrowser,
  sleep: (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)),
  machine: () => machineName(),
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
 * GitHub token, which the caller sends once to the API and never keeps.
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

/** A day for a person: 2027-01-19. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * `shaderera login [--api <origin>] [--no-open]`: signs in with GitHub (the device flow), swaps
 * the GitHub token once at the API's `POST /api/v1/auth/github`, with this machine's name, for a
 * Shaderera token for this machine, and keeps that one for `share`. `shaderera login --token
 * <token> [--api <origin>]` keeps a token given by hand. No token, GitHub's or Shaderera's, is
 * ever printed or written anywhere but the token file.
 */
export const run = async (argv: readonly string[], deps: LoginDeps = defaults): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: { token: { type: 'string' }, api: { type: 'string' }, 'no-open': { type: 'boolean' } },
  })
  const api = apiOf(v.api)
  if (v.token !== undefined) {
    const token = v.token.trim()
    if (!token) throw new Error('Usage: shaderera login [--token <token>] [--api <origin>]')
    console.log(`token for ${api} saved in ${saveToken(api, token)}`)
    return 0
  }
  const clientId = process.env.SHADERERA_GITHUB_CLIENT_ID?.trim() || deps.clientId
  if (!clientId)
    throw new Error(
      "GitHub sign-in isn't set up in this shaderera yet (its GitHub OAuth App client id is empty): use shaderera login --token <token>.",
    )
  const github = await deviceFlow(deps, clientId, v['no-open'] === true, (l) => console.log(l))
  let r: Response
  try {
    r = await call(api, 'POST', '/auth/github', { json: { token: github, name: deps.machine() } })
  } catch (e) {
    // The API answers 503 when its GitHub App is not set up.
    if (/: 503 /.test((e as Error).message))
      throw new Error(
        `${api} has no GitHub sign-in set up yet: use shaderera login --token <token>${apiFlag(api)}.`,
      )
    throw e
  }
  const signed = (await r.json()) as {
    token?: unknown
    handle?: unknown
    name?: unknown
    expiresAt?: unknown
  }
  if (typeof signed.token !== 'string' || !signed.token || typeof signed.handle !== 'string')
    throw new Error(`${api} sent no token for the sign-in.`)
  saveToken(api, signed.token)
  const until = typeof signed.expiresAt === 'number' ? `, until ${dayOf(signed.expiresAt)}` : ''
  const machine = typeof signed.name === 'string' ? ` as "${signed.name}"` : ''
  console.log(
    `Signed in as ${signed.handle}${api === DEFAULT_API ? '' : ` on ${api}`}: this machine${machine}${until}`,
  )
  return 0
}
