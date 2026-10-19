import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Whether `file` is outside `root`: above it, or on another drive. */
export const outside = (root: string, file: string) => {
  const rel = relative(root, file)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * A project-relative path as an absolute one, refusing anything outside the project, also through
 * a symbolic link. A path that does not exist yet is checked through its nearest existing parent.
 * `why` ends the refusal: the reason it is refused.
 */
export const inside = (root: string, path: string, why?: string): string => {
  const because = why ? `: ${why}` : ''
  const file = resolve(root, path)
  if (outside(resolve(root), file)) throw new Error(`${path} is outside the project${because}.`)
  let real = file
  const rest: string[] = []
  while (!existsSync(real) && dirname(real) !== real) {
    rest.unshift(basename(real))
    real = dirname(real)
  }
  if (outside(realpathSync(root), join(realpathSync(real), ...rest))) {
    throw new Error(`${path} is outside the project (through a link)${because}.`)
  }
  return file
}

/** Why a film reads only its project's files. */
const READ =
  "a film reads only its project's files, so that each revision holds everything it reads: copy the file into the project"

/**
 * `inside` for reading: also an installed package's file, which a package manager links from
 * somewhere else (pnpm's store), when the path is under the project's node_modules and the real
 * file is in a node_modules too. Writes never get this.
 */
export const insideForRead = (root: string, path: string): string => {
  try {
    return inside(root, path, READ)
  } catch (error) {
    const file = resolve(root, path)
    const modules = join(resolve(root), 'node_modules') + sep
    if (!file.startsWith(modules) || !existsSync(file)) throw error
    if (!realpathSync(file).split(sep).includes('node_modules')) throw error
    return file
  }
}
