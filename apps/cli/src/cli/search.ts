import { run as addOn } from '../registry/cli.ts'

/** `shaderera search`: one of the add-on commands (src/registry/). */
export const run = (argv: readonly string[]): Promise<number> => addOn('search', argv)
