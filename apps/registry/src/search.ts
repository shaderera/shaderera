import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import MiniSearch from 'minisearch'
import type { Version } from './store.ts'

/**
 * Full-text search over the registry, an inverted index in the spirit of Lucene and Tantivy but
 * in JavaScript, so the CLI needs no native binary: built once when an item is published,
 * stored as `search.json`, loaded and queried locally. It covers the label (name, title,
 * description, category, tags) and the code (exported names, WGSL functions, the first line of
 * each doc comment), so "is there a fitFov already?" finds the extension that has one.
 */
const OPTIONS = {
  idField: 'name',
  fields: ['name', 'title', 'description', 'category', 'tags', 'symbols', 'notes'],
  storeFields: ['name', 'title', 'description', 'type', 'category', 'tags', 'version', 'licence'],
  searchOptions: { boost: { name: 3, title: 2, tags: 2, symbols: 1.5 }, prefix: true, fuzzy: 0.2 },
}

type Doc = {
  name: string
  title: string
  description: string
  type: string
  category: string
  tags: string
  version: string
  licence: string
  symbols: string
  notes: string
}

const docOf = (v: Version): Doc => {
  const [names, notes] = [
    v.symbols.filter((s) => !s.startsWith('# ')),
    v.symbols.filter((s) => s.startsWith('# ')),
  ]
  return {
    name: v.item.name,
    title: v.item.title,
    description: v.item.description,
    type: v.item.type,
    category: v.item.category,
    // one tag a line, so a tag may have spaces
    tags: v.item.tags.join('\n'),
    version: v.item.version,
    licence: v.item.licence,
    // camelCase and snake_case split so "fov" finds fitFov
    symbols: names
      .map((s) => `${s} ${s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')}`)
      .join(' '),
    notes: notes.map((s) => s.slice(2)).join(' '),
  }
}

export const buildSearch = (versions: readonly Version[]): unknown => {
  const ms = new MiniSearch<Doc>(OPTIONS)
  ms.addAll(versions.map(docOf))
  return ms.toJSON()
}

export type Hit = {
  name: string
  title: string
  description: string
  type: string
  category: string
  tags: string
  version: string
  licence: string
  score: number
}

export const search = (registry: string, query: string): Hit[] => {
  const ms = MiniSearch.loadJSON<Doc>(readFileSync(join(registry, 'search.json'), 'utf8'), OPTIONS)
  // No words lists everything.
  return (query.trim() ? ms.search(query) : ms.search(MiniSearch.wildcard)) as unknown as Hit[]
}

/**
 * What a version's code exports, for search: `export const|function|class|type|interface X`,
 * WGSL `fn x(`, each doc comment's first line and the README's first paragraph (kept as "# text").
 */
export const symbolsOf = (dir: string, files: readonly string[]): string[] => {
  const out = new Set<string>()
  for (const f of files) {
    if (f === 'README.md') {
      const first = readFileSync(join(dir, f), 'utf8').split(/\r?\n\s*\r?\n/)[0] ?? ''
      if (first.trim()) out.add(`# ${first.replace(/\s+/g, ' ').trim()}`)
      continue
    }
    if (!/\.(ts|tsx|js|mjs|wgsl)$/.test(f)) continue
    const text = readFileSync(join(dir, f), 'utf8')
    for (const m of text.matchAll(
      /export\s+(?:default\s+)?(?:async\s+)?(?:const|let|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g,
    ))
      out.add(m[1] as string)
    for (const m of text.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)) out.add(m[1] as string)
    for (const m of text.matchAll(/\/\*\*\s*\n?\s*\*?\s*([^\n*][^\n]*)/g))
      out.add(`# ${(m[1] as string).trim()}`)
  }
  return [...out]
}
