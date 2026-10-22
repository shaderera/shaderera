import { parseArgs } from 'node:util'
import { EXIT } from './findings.ts'
import { dayOf } from './login.ts'
import { apiOf, call, readToken, signInHint } from './site.ts'

/** Whose the token for `api` is, as `GET /api/v1/auth/me` answers; null without a token. */
export const whoIs = async (
  api: string,
): Promise<{ handle: string; name: string; expiresAt: number } | null> => {
  const token = readToken(api)
  if (!token) return null
  return (await (await call(api, 'GET', '/auth/me', { token })).json()) as {
    handle: string
    name: string
    expiresAt: number
  }
}

/**
 * `shaderera whoami [--api <origin>] [--json]`: who this machine is signed in as on the API, the
 * name the API knows it by, and until when. Not signed in, or a token the API no longer takes:
 * it says how to sign in, and exits 1.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: { api: { type: 'string' }, json: { type: 'boolean' } },
  })
  const api = apiOf(v.api)
  let me: Awaited<ReturnType<typeof whoIs>>
  let why = 'Not signed in to'
  try {
    me = await whoIs(api)
  } catch (e) {
    // Expired, signed out elsewhere, or replaced: the token is kept, and is no one's.
    if (!/: 401 /.test((e as Error).message)) throw e
    me = null
    why = 'The token here is no longer signed in to'
  }
  if (!me) {
    if (v.json) console.log(JSON.stringify({ api, signedIn: false }, null, 2))
    else console.log(`${why} ${api}. ${signInHint(api)}`)
    return EXIT.failed
  }
  if (v.json) console.log(JSON.stringify({ api, signedIn: true, ...me }, null, 2))
  else
    console.log(
      `${me.handle} on ${api}: this machine as "${me.name}", until ${dayOf(me.expiresAt)}`,
    )
  return EXIT.ok
}
