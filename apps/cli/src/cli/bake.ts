import { findProject } from '../node/project.ts'
import { makeBake } from '../project/bakes.ts'
import { parseWithPositionals } from './args.ts'

/**
 * `shaderera bake [name...]`: runs each named bake's command (every declared bake when none is
 * named) with the person's rights, in the project folder, and stamps what it made in
 * `versions/bakes/<name>.json`: its inputs' hash and every frame's size and hash. Decision 0016.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseWithPositionals(argv, {})
  const { root, manifest } = await findProject(
    typeof values.root === 'string' ? values.root : process.cwd(),
  )
  const names = positionals.length > 0 ? positionals : Object.keys(manifest.bakes ?? {})
  if (names.length === 0) throw new Error('shaderera.json declares no bakes.')
  for (const name of names) {
    const started = performance.now()
    const stamp = makeBake(root, manifest, name)
    const bytes = stamp.frames.reduce((n, f) => n + f.bytes, 0)
    console.log(
      `${name}: ${stamp.frames.length} frames, ${(bytes / 2 ** 20).toFixed(1)} MB in ${stamp.dir}, ${((performance.now() - started) / 1000).toFixed(1)} s; stamped`,
    )
  }
  return 0
}
