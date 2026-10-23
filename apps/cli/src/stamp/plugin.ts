import path from 'node:path'
import MagicString from 'magic-string'
import { parseSync } from 'oxc-parser'
import type { Plugin } from 'vite'

/**
 * The source stamp: instrumentation, not representation. Every object literal with an `id` key in
 * a project file gets one more enumerable key, `source: "relative/path.ts:line:col"` (1-based, the
 * position of its `{`). `source` means the literal associated with this inspectable object, not
 * the line responsible for every computed value. Spread copies it. Objects without `id`, and
 * objects that already have `source`, are untouched. oxc offsets count UTF-16 code units.
 */

const FILE = /\.(ts|tsx|js|jsx|mts)$/
/** Relative to the project root: a staged or frozen root under .shaderera is still stamped. */
const SKIP = /(^|[/])(node_modules|\.shaderera)[/]/

type Node = { type: string; start: number; end: number; [key: string]: unknown }

const keyName = (p: Node): string | undefined => {
  if (p.type !== 'Property' || p.computed) return undefined
  const k = p.key as Node & { name?: string; value?: unknown }
  if (k.type === 'Identifier') return k.name
  return typeof k.value === 'string' ? k.value : undefined
}

/** Calls `visit` on every node of an oxc AST. */
const walk = (node: unknown, visit: (n: Node) => void): void => {
  if (Array.isArray(node)) for (const n of node) walk(n, visit)
  else if (node && typeof node === 'object') {
    if (typeof (node as Node).type === 'string') visit(node as Node)
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, visit)
  }
}

/** Line and column (1-based) of a UTF-16 offset. */
const lineCol = (code: string, offset: number): [number, number] => {
  const before = code.slice(0, offset).split('\n')
  return [before.length, (before.at(-1)?.length ?? 0) + 1]
}

/** Stamps one file's code; `file` is the path shown in `source`, `mapSource` the map's source. */
export const stampCode = (code: string, file: string, mapSource = file) => {
  const ast = parseSync(file, code).program
  const s = new MagicString(code)
  walk(ast, (n) => {
    if (n.type !== 'ObjectExpression') return
    const keys = (n.properties as Node[]).map(keyName)
    if (!keys.includes('id') || keys.includes('source')) return
    const [line, col] = lineCol(code, n.start)
    s.appendLeft(n.start + 1, ` source: ${JSON.stringify(`${file}:${line}:${col}`)},`)
  })
  if (!s.hasChanged()) return null
  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: mapSource, includeContent: true }),
  }
}

/**
 * The path of `file` relative to `root`, with `/` separators, or null when it is outside `root`.
 * Across Windows drives `relative()` returns an absolute path, which is outside too.
 */
export const projectPath = (root: string, file: string, p: typeof path = path): string | null => {
  const rel = p.relative(root, file)
  if (rel.startsWith('..') || p.isAbsolute(rel)) return null
  return rel.replaceAll('\\', '/')
}

/** A Vite plugin that stamps `source` on `id` literals in files under `root` (manifest `stamp`). */
export const stamp = ({ root }: { root: string }): Plugin => ({
  name: 'shaderera:stamp',
  enforce: 'pre',
  transform(code, id) {
    const abs = id.split('?')[0] ?? id
    const file = projectPath(root, abs)
    if (!FILE.test(abs) || file === null || SKIP.test(file)) return null
    return stampCode(code, file, abs)
  },
})
