import { parseArgs } from 'node:util'
import { saveToken, siteOf } from './site.ts'

/** `shaderera login --token <token> [--to <origin>]`: keeps the token `share` sends to that site. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: { token: { type: 'string' }, to: { type: 'string' } },
  })
  const token = v.token?.trim()
  if (!token) throw new Error('Usage: shaderera login --token <token> [--to <origin>]')
  const site = siteOf(v.to)
  // The token itself is never printed.
  console.log(`token for ${site} saved in ${saveToken(site, token)}`)
  return 0
}
