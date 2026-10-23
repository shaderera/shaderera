import assert from 'node:assert/strict'
import { join, posix, resolve, win32 } from 'node:path'
import { test } from 'node:test'
import { parseSync } from 'oxc-parser'
import { stamp as plugin, projectPath, stampCode } from './plugin.ts'

test('oxc offsets count UTF-16 code units', () => {
  const code = "const s = 'ไทย'\nconst o = { id: 1 }"
  const ast = parseSync('a.ts', code).program as unknown as {
    body: { declarations: { init: { start: number } }[] }[]
  }
  assert.equal(ast.body[1]?.declarations[0]?.init.start, code.indexOf('{'))
})

test('stamps id literals at their brace, after Thai text, in TS', () => {
  const code = [
    "const t = 'สื่อที่เขียนด้วยโค้ด'",
    "const title = { id: 'title', x: 1, nested: { id: 'n', y: 2 } }",
    'const plain = { x: 1 }',
    "const done = { id: 'd', source: 'kept' }",
    "const quoted = { 'id': 'q' }",
    'const computed = { [id]: 1 }',
  ].join('\n')
  const out = stampCode(code, 'src/a.ts')?.code ?? ''
  assert.match(out, /const title = \{ source: "src\/a\.ts:2:15", id: 'title'/)
  assert.match(out, /nested: \{ source: "src\/a\.ts:2:44", id: 'n'/)
  assert.match(out, /const plain = \{ x: 1 \}/)
  assert.match(out, /const done = \{ id: 'd', source: 'kept' \}/)
  assert.match(out, /const quoted = \{ source: "src\/a\.ts:5:16", 'id'/)
  assert.match(out, /const computed = \{ \[id\]: 1 \}/)
})

test('stamps TSX and returns nothing when there is nothing to stamp', () => {
  const code = "const a = <div style={{ id: 'x' }} />"
  assert.match(stampCode(code, 'b.tsx')?.code ?? '', /\{ source: "b\.tsx:1:23", id: 'x' \}/)
  assert.equal(stampCode('const a = { x: 1 }', 'c.ts'), null)
})

test('the source map maps the stamped object back to its line', () => {
  const code = "// one\n// two\nconst title = { id: 'title' }"
  const r = stampCode(code, 'a.ts')
  assert.ok(r)
  const lines = r.map.mappings.split(';')
  assert.equal(lines.length, 3)
  assert.equal((lines[2] ?? '').length > 0, true)
  // The third generated line maps to the third original line: its first segment's line delta
  // accumulates to 2 (source line index), checked by decoding nothing fancier than VLQ.
  const vlq = (s: string): number[] => {
    const out: number[] = []
    let shift = 0
    let n = 0
    for (const ch of s) {
      const d = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(ch)
      n += (d & 31) << shift
      if (d & 32) shift += 5
      else {
        out.push(n & 1 ? -(n >> 1) : n >> 1)
        n = 0
        shift = 0
      }
    }
    return out
  }
  let line = 0
  for (const l of lines) for (const seg of l.split(',').filter(Boolean)) line += vlq(seg)[2] ?? 0
  assert.equal(line, 2)
})

test('a staged or frozen root under .shaderera is stamped; its own node_modules and .shaderera are not', () => {
  const code = "const o = { id: 'x' }"
  // Native separators: POSIX paths in E2, backslashes on Windows.
  const root = resolve('p', '.shaderera', 'revisions', 'abc')
  const t = plugin({ root }).transform as (code: string, id: string) => { code: string } | null
  assert.match(t(code, join(root, 'src', 'a.ts'))?.code ?? '', /source: "src\/a\.ts:1:11"/)
  assert.equal(t(code, join(root, 'node_modules', 'm', 'i.ts')), null)
  assert.equal(t(code, join(root, '.shaderera', 'node', 'entry.js')), null)
})

test('a file on another Windows drive is outside the project (#343)', () => {
  const root = 'D:\\film'
  assert.equal(projectPath(root, 'D:\\film\\src\\a.ts', win32), 'src/a.ts')
  assert.equal(projectPath(root, 'D:/film/src/a.ts', win32), 'src/a.ts')
  // relative() across drives returns an absolute path, not one that starts with `..`.
  assert.equal(
    win32.relative(root, 'C:\\shaderera\\runner\\worker.ts'),
    'C:\\shaderera\\runner\\worker.ts',
  )
  assert.equal(projectPath(root, 'C:\\shaderera\\runner\\worker.ts', win32), null)
  assert.equal(projectPath(root, 'C:/shaderera/runner/worker.ts', win32), null)
  assert.equal(projectPath(root, 'D:\\other\\a.ts', win32), null)
  assert.equal(projectPath('/p/film', '/p/film/src/a.ts', posix), 'src/a.ts')
  assert.equal(projectPath('/p/film', '/q/a.ts', posix), null)
})
