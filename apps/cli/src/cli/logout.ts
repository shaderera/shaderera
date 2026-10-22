import { parseArgs } from 'node:util'
import { apiOf, call, readToken, removeToken } from './site.ts'

/**
 * `shaderera logout [--api <origin>] [--all]`: signs this machine out at the API's
 * `POST /api/v1/auth/logout` (`--all`: every machine of the user), then forgets the token here.
 * A token the API no longer takes (401) is already signed out; the API unreachable stops it, and
 * the token is kept, so that it can be signed out later.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: { api: { type: 'string' }, all: { type: 'boolean' } },
  })
  const api = apiOf(v.api)
  const token = readToken(api)
  if (!token) {
    console.log(`Not signed in to ${api}.`)
    return 0
  }
  try {
    await call(api, 'POST', '/auth/logout', { token, ...(v.all ? { json: { all: true } } : {}) })
  } catch (e) {
    if (!/: 401 /.test((e as Error).message)) throw e
  }
  removeToken(api)
  console.log(`Signed out of ${api}${v.all ? ' on every machine' : ''}.`)
  return 0
}
