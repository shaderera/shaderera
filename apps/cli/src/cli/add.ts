import { run as addOn } from '../registry/cli.ts'

/** `shaderera add`: one of the add-on commands (src/registry/). */
export const run = (argv: readonly string[]): Promise<number> => addOn('add', argv)
