import { run as addOn } from '../registry/cli.ts'

/** `shaderera remove`: one of the add-on commands (src/registry/). */
export const run = (argv: readonly string[]): Promise<number> => addOn('remove', argv)
