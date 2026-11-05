// Every analysis an official plugin writes or reads has the one header of docs/analysis.md and the
// plugin guide's conventions: `format: 'shaderera.analysis/1'`, a `kind`, a `source` with its
// path, bytes and sha256 (or, for a live page, its url, date, viewport, device pixel ratio and
// the sha256 of each response), a `tool` and its `params`. The check reads the plugins' code, TypeScript
// and Python, for every object that names the format, and parses the artifacts committed beside
// them. It fails on a header in any other shape, such as the old `kind: 'shaderera.analysis/1'`
// with `of: { path, sha256 }`.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

const plugins = join(import.meta.dirname, '..')
const FORMAT = 'shaderera.analysis/1'
const name = (file: string) => relative(plugins, file).replaceAll('\\', '/')
const NOT_PLUGINS = new Set(['node_modules', 'out', 'previews', 'test'])

/** Every file under `dir` whose name passes `keep`, but out/ and node_modules/. */
const files = (dir: string, keep: (name: string) => boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'out' || e.name === 'node_modules') return []
    const path = join(dir, e.name)
    return e.isDirectory() ? files(path, keep) : keep(e.name) ? [path] : []
  })

const pluginDirs = () =>
  readdirSync(plugins, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !NOT_PLUGINS.has(e.name))
    .map((e) => join(plugins, e.name))

/** What is wrong with a parsed artifact's header: nothing when it is in the shared shape. */
const headerProblems = (doc: unknown): string[] => {
  const d = (doc ?? {}) as Record<string, unknown>
  const source = (d.source ?? {}) as Record<string, unknown>
  const wrong: string[] = []
  if (d.format !== FORMAT) wrong.push(`format is ${JSON.stringify(d.format)}, not "${FORMAT}"`)
  if (typeof d.kind !== 'string' || d.kind === FORMAT) wrong.push('kind does not name the analysis')
  if ('url' in source) {
    const responses = Array.isArray(source.responses) ? source.responses : null
    if (typeof source.url !== 'string') wrong.push('source.url is not a string')
    if (typeof source.date !== 'string') wrong.push('source.date is missing')
    if (typeof source.viewport !== 'object' || source.viewport === null)
      wrong.push('source.viewport is missing')
    if (typeof source.devicePixelRatio !== 'number')
      wrong.push('source.devicePixelRatio is missing')
    if (!responses) wrong.push('source.responses is missing')
    else if (
      responses.some(
        (r) =>
          !(r?.sha256 === null && r?.hashOf === 'none') &&
          !/^[0-9a-f]{64}$/.test(String(r?.sha256)),
      )
    )
      wrong.push("a source response's sha256 is not a sha256 in hex")
  } else {
    if (typeof source.path !== 'string') wrong.push('source.path is missing')
    if (typeof source.bytes !== 'number') wrong.push('source.bytes is missing')
    if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256))
      wrong.push('source.sha256 is not a sha256 in hex')
  }
  if (typeof d.tool !== 'object' || d.tool === null) wrong.push('tool is missing')
  if (typeof d.params !== 'object' || d.params === null) wrong.push('params is missing')
  return wrong
}

/** The object literal (TypeScript) or dict (Python) around `at`, braces and all. */
const enclosing = (code: string, at: number) => {
  let depth = 0
  let open = at
  for (; open >= 0; open--) {
    const c = code[open]
    if (c === '}') depth++
    else if (c === '{' && depth-- === 0) break
  }
  depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return code.slice(open, i + 1)
  }
  return code.slice(Math.max(0, open))
}

/**
 * What is wrong with the headers a piece of code writes, declares or reads. The format string
 * may only be the value of `format` or what `format` is compared with; where it is the value, the
 * object around it must also hold `kind`, `source` (path, bytes, sha256), `tool` and `params`.
 */
const codeProblems = (code: string): string[] => {
  const wrong: string[] = []
  for (const m of code.matchAll(/(['"])shaderera\.analysis\/1\1/g)) {
    const at = m.index ?? 0
    const line = code.slice(0, at).split('\n').length
    const before = code.slice(Math.max(0, at - 40), at)
    if (/format['"]?\)?\s*(!==|===|!=|==)\s*$/.test(before)) continue
    if (!/\bformat['"]?\s*:\s*$/.test(before)) {
      wrong.push(`line ${line}: the format is not the value of \`format\``)
      continue
    }
    const object = enclosing(code, at)
    const has = (key: string) => new RegExp(`['"]?\\b${key}\\b['"]?\\s*[:,}]`).test(object)
    for (const key of ['kind', 'tool', 'params'])
      if (!has(key)) wrong.push(`line ${line}: the header has no \`${key}\``)
    const file = /['"]?\bsource\b['"]?\s*:\s*\{[^}]*\bpath\b[^}]*\bbytes\b[^}]*\bsha256\b/
    const page = /['"]?\bsource\b['"]?\s*:\s*\{[^}]*\burl\b[^}]*\bdate\b[^}]*\bviewport\b/
    // analysis-reference-tracks' writer builds a file source with its own helper.
    const helper = /['"]?\bsource\b['"]?\s*:\s*(await\s+)?fileSource\(/
    if (!file.test(object) && !page.test(object) && !helper.test(object))
      wrong.push(
        `line ${line}: the header's \`source\` lacks path, bytes and sha256 (or a page's url, date and viewport), in that order`,
      )
  }
  return wrong
}

test('the check fails on the old header and passes the shared one', () => {
  const old = `const out = {\n  kind: 'shaderera.analysis/1',\n  of: { path: src, sha256 },\n  duration: 1,\n}`
  assert.deepEqual(codeProblems(old), ['line 2: the format is not the value of `format`'])
  const noTool = `doc = {'format': 'shaderera.analysis/1', 'kind': 'shots',\n  'source': {'path': p, 'bytes': n, 'sha256': h}, 'params': {}}`
  assert.deepEqual(codeProblems(noTool), ['line 1: the header has no `tool`'])
  assert.deepEqual(
    codeProblems(
      `type A = {\n  format: 'shaderera.analysis/1'\n  kind: 'music'\n  source: { path: string; bytes: number; sha256: string }\n  tool: Record<string, unknown>\n  params: Record<string, unknown>\n}\nif (doc.format !== 'shaderera.analysis/1') throw 0`,
    ),
    [],
  )
  assert.deepEqual(
    codeProblems(
      `const doc = { format: 'shaderera.analysis/1', kind: 'reference-tracks',\n  source: { url, date, viewport, devicePixelRatio, responses }, tool, params }`,
    ),
    [],
  )
  const page = {
    url: 'https://example.com/',
    date: '2026-11-04T00:00:00.000Z',
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1,
    responses: [{ url: 'https://example.com/', status: 200, sha256: 'a'.repeat(64) }],
  }
  const header = { format: FORMAT, kind: 'reference-tracks', tool: {}, params: {} }
  assert.deepEqual(headerProblems({ ...header, source: page }), [])
  assert.deepEqual(
    headerProblems({ ...header, source: { ...page, responses: [{ url: 'x', sha256: 'no' }] } }),
    ["a source response's sha256 is not a sha256 in hex"],
  )
  // A body that could not be read has no hash, and says so.
  const unread = { url: 'x', status: 200, sha256: null, hashOf: 'none' }
  assert.deepEqual(headerProblems({ ...header, source: { ...page, responses: [unread] } }), [])
  assert.deepEqual(
    headerProblems({
      ...header,
      source: { ...page, responses: [{ ...unread, hashOf: undefined }] },
    }),
    ["a source response's sha256 is not a sha256 in hex"],
  )
  assert.deepEqual(
    headerProblems({ kind: FORMAT, of: { path: 'a.wav', sha256: 'f'.repeat(64) } }),
    [
      'format is undefined, not "shaderera.analysis/1"',
      'kind does not name the analysis',
      'source.path is missing',
      'source.bytes is missing',
      'source.sha256 is not a sha256 in hex',
      'tool is missing',
      'params is missing',
    ],
  )
})

test("every plugin's analysis header, in its code and in its committed artifacts, has the shared shape", () => {
  const wrong: string[] = []
  let headers = 0
  for (const dir of pluginDirs()) {
    for (const file of files(dir, (n) => /\.(ts|py)$/.test(n))) {
      const code = readFileSync(file, 'utf8')
      headers += [...code.matchAll(/(['"])shaderera\.analysis\/1\1/g)].length
      for (const w of codeProblems(code)) wrong.push(`${name(file)} ${w}`)
    }
    for (const file of files(dir, (n) => n.endsWith('.json'))) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(FORMAT)) continue
      headers++
      for (const w of headerProblems(JSON.parse(text))) wrong.push(`${name(file)}: ${w}`)
    }
  }
  assert.deepEqual(wrong, [])
  assert.ok(headers >= 12, `only ${headers} headers found: the check is not reading the plugins`)
})
