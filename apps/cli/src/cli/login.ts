import { parseArgs } from 'node:util'
import { apiOf, saveToken } from './site.ts'

/** `shaderera login --token <token> [--api <origin>]`: keeps the token `share` sends to that API. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: { token: { type: 'string' }, api: { type: 'string' } },
  })
  const token = v.token?.trim()
  if (!token) throw new Error('Usage: shaderera login --token <token> [--api <origin>]')
  const api = apiOf(v.api)
  // The token itself is never printed.
  console.log(`token for ${api} saved in ${saveToken(api, token)}`)
  return 0
}
