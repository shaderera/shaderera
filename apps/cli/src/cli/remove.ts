import { run as plugin } from '../registry/cli.ts'

/** `shaderera remove`: one of the plugin commands (src/registry/). */
export const run = (argv: readonly string[]): Promise<number> => plugin('remove', argv)
