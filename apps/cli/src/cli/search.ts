import { run as plugin } from '../registry/cli.ts'

/** `shaderera search`: one of the plugin commands (src/registry/). */
export const run = (argv: readonly string[]): Promise<number> => plugin('search', argv)
