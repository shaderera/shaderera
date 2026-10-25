import { readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** A studio export's name: `<project>[-<variant>]-<job id>.<format>` (bridge.ts). */
const EXPORT = /^(.+)-[0-9a-f]{12}\.(mp4|mov|png)$/

/**
 * After a studio export, removes the older studio exports of the same variant and format in its
 * folder (`out/studio/`): files with its name but another job id. Any other file, one the person
 * renamed or moved out, is never touched; one that cannot be removed now (being downloaded on
 * Windows) is left.
 */
export const keepNewestExport = (file: string) => {
  const m = EXPORT.exec(basename(file))
  if (!m) return
  const [, stem, format] = m
  let names: string[] = []
  try {
    names = readdirSync(dirname(file))
  } catch {}
  for (const name of names) {
    const other = EXPORT.exec(name)
    if (!other || name === basename(file) || other[1] !== stem || other[2] !== format) continue
    try {
      rmSync(join(dirname(file), name))
    } catch {}
  }
}
