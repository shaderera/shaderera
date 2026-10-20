import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  changedFiles,
  head,
  materialize,
  readRevision,
  restore,
  save,
  scan,
  undo,
} from './revisions.ts'

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-rev-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'shaderera.json'), '{}')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const headline = "One"\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const color = "#fff"\n')
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '')
  writeFileSync(join(root, 'out', 'film.mp4'), 'x')
  return root
}
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8')

test('a revision is the project files only, and the same tree has the same id', () => {
  const root = project()
  assert.deepEqual(Object.keys(scan(root)), ['shaderera.json', 'src/a.ts', 'src/b.ts'])
  // Only the root's out/ is renders; a source folder named out is source. A temporary file is not.
  mkdirSync(join(root, 'src', 'out'))
  writeFileSync(join(root, 'src', 'out', 'palette.ts'), '')
  writeFileSync(join(root, 'src', 'a.ts.4242.tmp'), '')
  assert.deepEqual(Object.keys(scan(root)), [
    'shaderera.json',
    'src/a.ts',
    'src/b.ts',
    'src/out/palette.ts',
  ])
  const a = save(root, { by: 'person', label: 'first' })
  assert.equal(save(root, { by: 'person' }).id, a.id)
  assert.equal(head(root), a.id)
  assert.equal(readRevision(root, a.id).label, 'first')
})

test('undo returns to the previous revision and keeps unsaved edits as a revision', () => {
  const root = project()
  const one = save(root, { by: 'person' })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const headline = "Two"\n')
  writeFileSync(join(root, 'src', 'c.ts'), 'new file\n')
  const back = undo(root)
  assert.equal(back.id, one.id)
  assert.match(read(root, 'src/a.ts'), /One/)
  assert.equal(existsSync(join(root, 'src', 'c.ts')), false)
  // The undone edit is still a revision: undoing the undo brings it back.
  assert.equal(save(root, { by: 'person' }).id, one.id)
  assert.match(read(root, 'src/a.ts'), /One/)
  undo(root)
  assert.match(read(root, 'src/a.ts'), /Two/)
  assert.equal(existsSync(join(root, 'src', 'c.ts')), true)
})

test('undo with nothing before it is refused', () => {
  const root = project()
  save(root, { by: 'person' })
  assert.throws(() => undo(root), /Nothing to undo/)
})

test('restore brings back a revision exactly and can itself be undone', () => {
  const root = project()
  const one = save(root, { by: 'person' })
  writeFileSync(join(root, 'src', 'b.ts'), 'export const color = "#000"\n')
  const two = save(root, { by: 'person' })
  restore(root, one.id)
  assert.match(read(root, 'src/b.ts'), /#fff/)
  assert.equal(undo(root).id, two.id)
  assert.match(read(root, 'src/b.ts'), /#000/)
  restore(root, one.id)
  restore(root, two.id)
  assert.match(read(root, 'src/b.ts'), /#000/)
  assert.deepEqual(changedFiles(one.files, two.files), {
    added: [],
    removed: [],
    changed: ['src/b.ts'],
  })
})

test('materialize writes a frozen copy that later edits do not touch', () => {
  const root = project()
  const one = save(root, { by: 'person' })
  const dir = materialize(root, one.id)
  writeFileSync(join(root, 'src', 'a.ts'), 'changed\n')
  assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /One/)
  assert.equal(materialize(root, one.id), dir)
})

test('a revision never stores or writes through a link, so restore cannot reach outside the project', () => {
  const root = project()
  // An outside folder, linked into the project as a directory junction.
  const outside = mkdtempSync(join(tmpdir(), 'shaderera-outside-'))
  writeFileSync(join(outside, 'marker.txt'), 'original\n')
  symlinkSync(outside, join(root, 'linked'), 'junction')
  // An internal link to the project's own folder, which would be a cycle if followed.
  symlinkSync(join(root, 'src'), join(root, 'src', 'again'), 'junction')
  const links: string[] = []
  assert.deepEqual(Object.keys(scan(root, { links })), ['shaderera.json', 'src/a.ts', 'src/b.ts'])
  assert.deepEqual(links.sort(), ['linked', 'src/again'])
  const one = save(root, { by: 'person' })
  writeFileSync(join(outside, 'marker.txt'), 'changed outside\n')
  restore(root, one.id)
  assert.equal(readFileSync(join(outside, 'marker.txt'), 'utf8'), 'changed outside\n')

  // A folder the revision holds, swapped for a link to the outside: restore refuses to write.
  const two = save(root, { by: 'person' })
  rmSync(join(root, 'src'), { recursive: true })
  symlinkSync(outside, join(root, 'src'), 'junction')
  assert.throws(() => restore(root, two.id), /src is a link/)
  assert.equal(existsSync(join(outside, 'a.ts')), false)
})

test('a revision and an object are checked before they are trusted', () => {
  const root = project()
  const base = save(root, { by: 'person' })
  // A revision edited by hand names a path it may not, or no longer matches its id.
  const file = join(root, 'versions', 'revisions', `${base.id}.json`)
  const text = readFileSync(file, 'utf8')
  for (const path of [
    '../a.ts',
    'src/../../a.ts',
    'C:/a.ts',
    'src/node_modules/a.ts',
    'out/a.ts',
  ]) {
    writeFileSync(file, text.replace('"src/a.ts"', JSON.stringify(path)))
    assert.throws(() => readRevision(root, base.id), /invalid file/, path)
  }
  writeFileSync(file, text.replace('"src/a.ts"', '"src/out/a.ts"'))
  assert.throws(() => readRevision(root, base.id), /does not match/)
  writeFileSync(file, text)
  // A corrupted object is refused, never written into the project.
  const hash = base.files['src/a.ts'] as string
  writeFileSync(join(root, 'versions', 'objects', hash), 'tampered\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'edited\n')
  assert.throws(() => restore(root, base.id), /corrupt/)
  assert.equal(read(root, 'src/a.ts'), 'edited\n')
})
