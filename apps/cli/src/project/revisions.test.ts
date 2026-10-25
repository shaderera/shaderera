import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import {
  changedFiles,
  head,
  materialize,
  readRevision,
  releaseFrozen,
  removeFrozen,
  restore,
  SECRET,
  save,
  scan,
  scanProject,
  undo,
  unusedFrozen,
  validPath,
} from './revisions.ts'

const project = () => {
  const root = tempDir('rev')
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

test('a frozen copy stays after its render; past three unused ones the least recently used go', () => {
  const root = project()
  const copies = join(root, '.shaderera', 'revisions')
  const ids = ['one', 'two', 'three', 'four', 'five'].map((t) => {
    writeFileSync(join(root, 'src', 'a.ts'), `export const headline = "${t}"\n`)
    return save(root, { by: 'person' }).id
  })
  const [one, two, three, four, five] = ids as [string, string, string, string, string]
  const ago = (id: string, minutes: number) => {
    const at = new Date(Date.now() - minutes * 60_000)
    utimesSync(join(copies, id), at, at)
  }
  // Two uses in this process: kept through both, and kept after them for the next render.
  const dir = materialize(root, one)
  materialize(root, one)
  releaseFrozen(root, one)
  releaseFrozen(root, one)
  assert.ok(existsSync(join(dir, 'src', 'a.ts')))
  assert.deepEqual(readdirSync(join(copies, `${one}.using`)), [])
  // Another live process (this one's parent) renders from two: it is never counted or removed.
  materialize(root, two)
  writeFileSync(join(copies, `${two}.using`, String(process.ppid)), '')
  releaseFrozen(root, two)
  // three was used by a process that died: unused.
  materialize(root, three)
  writeFileSync(join(copies, `${three}.using`, '999999999'), '')
  releaseFrozen(root, three)
  materialize(root, four)
  releaseFrozen(root, four)
  ago(one, 40)
  ago(two, 50)
  ago(three, 30)
  ago(four, 20)
  // A fifth render: one, three, four and five are unused; one, the oldest of them, goes.
  materialize(root, five)
  releaseFrozen(root, five)
  const left = readdirSync(copies).filter((n) => /^[0-9a-f]{16}$/.test(n))
  assert.deepEqual(left.sort(), [two, three, four, five].sort())
  assert.deepEqual(
    unusedFrozen(root).map((c) => c.id),
    [five, four, three],
  )
  // A copy kept is still checked: an edit to it is repaired on the next use.
  writeFileSync(join(copies, four, 'src', 'a.ts'), 'edited\n')
  assert.match(readFileSync(join(materialize(root, four), 'src', 'a.ts'), 'utf8'), /four/)
  releaseFrozen(root, four)
  // Releasing what this process never used removes nothing.
  releaseFrozen(root, one)
  assert.ok(existsSync(join(copies, two)))
})

test('a removal that races a render marking the copy gives it back, and never takes its mark', () => {
  const root = project()
  const id = save(root, { by: 'person' }).id
  const copies = join(root, '.shaderera', 'revisions')
  const dir = materialize(root, id)
  releaseFrozen(root, id)
  const other = join(copies, `${id}.using`, String(process.ppid))
  // Another process marks the copy just as this one moved it aside: it is put back whole.
  assert.equal(removeFrozen(root, id, { moved: () => writeFileSync(other, '') }), false)
  assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /One/)
  assert.ok(existsSync(other))
  rmSync(other)
  // It marked it and began writing a new copy there: the one aside goes, its mark stays, and its
  // materialize finishes a whole copy.
  removeFrozen(root, id, {
    moved: () => {
      writeFileSync(other, '')
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'b.ts'), 'export const color = "#fff"\n')
    },
  })
  assert.deepEqual(
    readdirSync(copies).filter((n) => n.includes('removing')),
    [],
  )
  assert.ok(existsSync(other))
  materialize(root, id)
  assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /One/)
  assert.ok(existsSync(join(dir, 'shaderera.json')))
  releaseFrozen(root, id)
  assert.ok(existsSync(other))
  rmSync(other)
  // Unmarked, it goes, with its empty marks folder.
  assert.equal(removeFrozen(root, id), true)
  assert.deepEqual(readdirSync(copies), [])
})

test('using a copy that needs no rewrite marks it used now', () => {
  const root = project()
  const id = save(root, { by: 'person' }).id
  const dir = materialize(root, id)
  releaseFrozen(root, id)
  const old = new Date(Date.now() - 3600_000)
  utimesSync(dir, old, old)
  materialize(root, id)
  assert.ok(Date.now() - statSync(dir).mtimeMs < 60_000)
  releaseFrozen(root, id)
})

test('a revision never stores or writes through a link, so restore cannot reach outside the project', () => {
  const root = project()
  // An outside folder, linked into the project as a directory junction.
  const outside = tempDir('outside')
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

test('a scan hashes again only the files whose size, time or inode changed, never a racy one', () => {
  const root = project()
  const a = join(root, 'src', 'a.ts')
  const b = join(root, 'src', 'b.ts')
  // Times an hour old: well before the moment they are hashed.
  const old = Date.now() / 1000 - 3600
  utimesSync(a, old, old)
  utimesSync(b, old, old)
  const first = scanProject(root)
  assert.deepEqual(first, scan(root))
  assert.ok(existsSync(join(root, '.shaderera', 'hashes.json')))

  // The same size and the same time: the remembered hash is used, so the file is not read.
  writeFileSync(a, 'export const headline = "Two"\n')
  utimesSync(a, old, old)
  assert.equal(scanProject(root)['src/a.ts'], first['src/a.ts'])

  // Another time: hashed again.
  utimesSync(a, old + 1, old + 1)
  assert.equal(scanProject(root)['src/a.ts'], scan(root)['src/a.ts'])

  // Racy: modified in the tick it was hashed, then edited to the same size and time.
  const now = Date.now() / 1000
  utimesSync(b, now, now)
  const racy = scanProject(root)
  writeFileSync(b, 'export const color = "#000"\n')
  utimesSync(b, now, now)
  assert.notEqual(scanProject(root)['src/b.ts'], racy['src/b.ts'])
  assert.equal(scanProject(root)['src/b.ts'], scan(root)['src/b.ts'])

  // A broken store of hashes: everything is hashed, as without one.
  writeFileSync(join(root, '.shaderera', 'hashes.json'), '{')
  assert.deepEqual(scanProject(root), scan(root))
  assert.equal(save(root).files['src/a.ts'], scan(root)['src/a.ts'])
})

test('secrets and ignored folders are matched in any case: a file named .ENV is never saved', () => {
  const root = project()
  // On a case-insensitive disk (NTFS, APFS) these are the same files as .env and out/; on a
  // case-sensitive one they are files of their own. Either way none is a revision's.
  writeFileSync(join(root, '.ENV'), 'TOKEN=secret\n')
  writeFileSync(join(root, 'src', 'ID.PEM'), 'key')
  writeFileSync(join(root, '.MCP.json'), '{"mcpServers":{"x":{"command":"evil"}}}')
  mkdirSync(join(root, 'OUT'), { recursive: true })
  writeFileSync(join(root, 'OUT', 'film.mp4'), 'x')
  mkdirSync(join(root, 'src', 'Node_Modules'), { recursive: true })
  writeFileSync(join(root, 'src', 'Node_Modules', 'x.js'), '')
  mkdirSync(join(root, '.GIT'), { recursive: true })
  writeFileSync(join(root, '.GIT', 'config'), '[remote] url = https://user:token@host/x')
  const saved = save(root, { by: 'person' })
  assert.deepEqual(Object.keys(saved.files).sort(), ['shaderera.json', 'src/a.ts', 'src/b.ts'])
  for (const path of ['.ENV', 'src/ID.PEM', 'OUT/film.mp4', '.GIT/config'])
    assert.equal(validPath(path) && !SECRET.test(path.split('/').at(-1) as string), false, path)
})
