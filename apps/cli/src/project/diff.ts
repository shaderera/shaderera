import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { changedFiles, type Files, fileAt, readRevision, scan } from './revisions.ts'

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|css|html|svg|glsl|wgsl)$/i

/**
 * What changed between two revisions, or a revision and the working tree (`b` omitted): the
 * files added, removed and changed, and a unified diff of the text files.
 */
export const diffRevisions = (
  root: string,
  a: string,
  b?: string,
): { added: string[]; removed: string[]; changed: string[]; patch: string } => {
  const from = readRevision(root, a).files
  const to: Files = b ? readRevision(root, b).files : scan(root)
  const files = changedFiles(from, to)
  const textAt = (rev: string | undefined, path: string): string => {
    if (rev) return fileAt(root, rev, path)?.toString('utf8') ?? ''
    const file = join(root, path)
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  const patch = [...files.changed, ...files.added, ...files.removed]
    .sort()
    .map((path) =>
      TEXT.test(path)
        ? createTwoFilesPatch(
            `a/${path}`,
            `b/${path}`,
            path in from ? textAt(a, path) : '',
            path in to ? textAt(b, path) : '',
            a,
            b ?? 'working tree',
          )
        : `Binary file ${path} differs\n`,
    )
    .join('')
  return { ...files, patch }
}
