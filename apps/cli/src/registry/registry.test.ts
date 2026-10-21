import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { run } from './cli.ts'
import { checkItem } from './item.ts'
import { add, remove } from './project.ts'
import { mirror } from './remote.ts'
import { assertRequirements, requirementProblems } from './requires.ts'
import { search } from './search.ts'
import { satisfies, validRange } from './semver.ts'
import { newest, publish, resolve } from './store.ts'

const temp = (name: string) => tempDir(`plugins-${name}`)
const write = (dir: string, files: { [path: string]: unknown }) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return dir
}

test('ranges: caret, tilde, comparators, x and alternatives; pre-release tags are ignored', () => {
  assert.ok(satisfies('1.4.2', '^1.2.0'))
  assert.ok(!satisfies('2.0.0', '^1.2.0'))
  assert.ok(satisfies('0.4.9', '^0.4.0') && !satisfies('0.5.0', '^0.4.0'))
  assert.ok(satisfies('1.2.9', '~1.2.3') && !satisfies('1.3.0', '~1.2.3'))
  assert.ok(satisfies('1.9.0', '>=1.2 <2') && !satisfies('2.0.0', '>=1.2 <2'))
  assert.ok(satisfies('3.0.0', '1.x || >=3'))
  assert.ok(satisfies('0.4.0-dev.0', '>=0.4.0') && satisfies('0.4.0-dev.0', '^0.4.0'))
  assert.ok(satisfies('7.0.0', '*'))
  assert.ok(!validRange('one point two'))
})

test('a label: what makes it unusable throws, what is merely unusual warns', () => {
  assert.throws(
    () =>
      checkItem(
        { name: 'x', type: 'plugin', category: 'Looks', version: '1.0.0', licence: 'MIT' },
        'x',
      ),
    /type must be/,
  )
  assert.throws(
    () =>
      checkItem(
        { name: 'x', type: 'preset', category: 'Looks', version: '1', licence: 'MIT' },
        'x',
      ),
    /not x\.y\.z/,
  )
  assert.throws(
    () =>
      checkItem(
        {
          name: 'x',
          type: 'preset',
          category: 'Looks',
          version: '1.0.0',
          licence: 'MIT',
          files: ['../up'],
        },
        'x',
      ),
    /outside/,
  )
  const { warnings } = checkItem(
    {
      name: 'x',
      type: 'preset',
      category: 'Moods',
      version: '1.0.0',
      licence: 'MIT',
      files: ['a.json'],
    },
    'x',
  )
  assert.ok(warnings.some((w) => /new for a preset/.test(w)))
})

const component = () =>
  write(temp('component'), {
    'shaderera.item.json': {
      name: 'text-code-wall',
      type: 'component',
      title: 'Code wall',
      description: "A wall of the film's own source, glitched",
      category: 'Typography',
      tags: ['glitch', 'code'],
      version: '0.1.0',
      licence: 'MIT',
      requires: { extensions: { '@shaderera/kinetic-type': '^0.1.0' } },
      files: ['src/code-wall.ts'],
    },
    'src/code-wall.ts':
      '/** Draws the source as a scrolling wall. */\nexport const drawCodeWall = () => 1\n',
  })

const project = () =>
  write(temp('project'), {
    'shaderera.json': { entry: 'src/composition.ts' },
    'package.json': { name: 'film', type: 'module' },
  })

test('publish, search by label and by code, resolve by range, and refuse a republish', () => {
  const registry = temp('reg')
  publish(component(), registry, { now: '2026-10-10' })
  assert.equal(search(registry, 'glitch')[0]?.name, 'text-code-wall')
  assert.equal(search(registry, 'drawCodeWall')[0]?.name, 'text-code-wall')
  assert.equal(search(registry, 'wall')[0]?.name, 'text-code-wall')
  assert.equal(search(registry, '').length, 1)
  assert.equal(resolve(registry, 'text-code-wall@^0.1').item.version, '0.1.0')
  assert.throws(() => resolve(registry, 'text-code-wall@^1'), /no version in \^1/)
  assert.throws(() => publish(component(), registry), /already published/)
})

test('a version whose bytes changed after publishing is refused', () => {
  const registry = temp('reg')
  publish(component(), registry)
  writeFileSync(
    join(registry, 'items', 'text-code-wall', '0.1.0', 'src', 'code-wall.ts'),
    'changed',
  )
  assert.throws(() => resolve(registry, 'text-code-wall'), /does not match its sha256/)
})

test('add copies a component, installs and requires what it needs; a missing one fails loudly with two ways out', () => {
  const registry = temp('reg')
  publish(component(), registry)
  const ext = write(temp('ext'), {
    'package.json': {
      name: '@shaderera/kinetic-type',
      version: '0.1.2',
      description: 'Scramble, decode and glitch text',
      license: 'MIT',
      type: 'module',
      shaderera: { category: 'Typography', tags: ['captions'] },
    },
    'index.js': 'export const scramble = (s) => s\n',
  })
  publish(ext, registry)
  const root = project()
  const installed: string[] = []
  const done = add(root, registry, 'text-code-wall', {
    install: (r, tgz) => {
      installed.push(tgz)
      write(r, {
        'node_modules/@shaderera/kinetic-type/package.json': {
          name: '@shaderera/kinetic-type',
          version: '0.1.2',
        },
      })
    },
  })
  assert.ok(existsSync(join(root, 'src', 'code-wall.ts')))
  assert.equal(installed.length, 1)
  assert.ok(done.some((d) => /installed @shaderera\/kinetic-type@0\.1\.2/.test(d)))
  const label = JSON.parse(readFileSync(join(root, 'shaderera.item.json'), 'utf8'))
  assert.equal(label.requires.extensions['@shaderera/kinetic-type'], '^0.1.2')
  assert.deepEqual(requirementProblems(root, '0.4.0'), [])

  // Removed: uninstalled and no longer required. A copied plugin is the project's to delete.
  const uninstalled: string[] = []
  remove(root, '@shaderera/kinetic-type', { uninstall: (_r, name) => uninstalled.push(name) })
  assert.deepEqual(uninstalled, ['@shaderera/kinetic-type'])
  assert.throws(() => remove(root, 'text-code-wall'), /files are this project's code/)
  assert.equal(
    JSON.parse(readFileSync(join(root, 'shaderera.item.json'), 'utf8')).requires.extensions[
      '@shaderera/kinetic-type'
    ],
    undefined,
  )

  // Required and missing: refused, naming it and the two ways out.
  write(root, {
    'shaderera.item.json': { requires: { extensions: { '@shaderera/music': '^1.0.0' } } },
  })
  assert.throws(
    () => assertRequirements(root, '0.4.0'),
    (e: Error) =>
      /@shaderera\/music \^1\.0\.0 \(not installed\)/.test(e.message) &&
      /shaderera add @shaderera\/music@\^1\.0\.0/.test(e.message) &&
      /shaderera remove @shaderera\/music/.test(e.message),
  )
  remove(root, '@shaderera/music', { uninstall: () => {} })
  assert.doesNotThrow(() => assertRequirements(root, '0.4.0'))
})

test('the shaderera range is checked too', () => {
  const root = write(project(), { 'shaderera.item.json': { requires: { shaderera: '^0.5.0' } } })
  assert.throws(
    () => assertRequirements(root, '0.4.0-dev.0'),
    /shaderera \^0\.5\.0 \(this is 0\.4\.0-dev\.0\)/,
  )
})

test('an item built on other items brings them in once, and never replaces what the project has', () => {
  const registry = temp('reg')
  const item = (name: string, file: string, items?: { [n: string]: string }) =>
    write(temp(name), {
      'shaderera.item.json': {
        name,
        type: 'component',
        category: 'Typography',
        version: '0.1.0',
        licence: 'MIT',
        ...(items ? { requires: { items } } : {}),
        files: [file],
      },
      [file]: `export const ${name.replace(/-/g, '')} = 1\n`,
      'README.md': `How to use ${name}.\n`,
    })
  publish(item('text-kinetic', 'src/type/kinetic.ts'), registry)
  publish(item('captions', 'src/type/captions.ts', { 'text-kinetic': '^0.1.0' }), registry)
  publish(item('text-code-wall', 'src/type/code-wall.ts', { 'text-kinetic': '^0.1.0' }), registry)
  const root = project()
  const first = add(root, registry, 'captions')
  assert.ok(existsSync(join(root, 'src', 'type', 'kinetic.ts')))
  assert.equal(first.length, 2)
  writeFileSync(join(root, 'src', 'type', 'kinetic.ts'), '// changed by hand\n')
  const second = add(root, registry, 'text-code-wall')
  assert.equal(second.length, 1)
  assert.equal(
    readFileSync(join(root, 'src', 'type', 'kinetic.ts'), 'utf8'),
    '// changed by hand\n',
  )
  // the README is published (info prints it) and searched, but never copied into the project
  assert.ok(existsSync(join(registry, 'items', 'captions', '0.1.0', 'README.md')))
  assert.ok(!existsSync(join(root, 'README.md')))
  assert.equal(search(registry, 'How to use captions')[0]?.name, 'captions')
})

test('an item that imports npm packages installs them, unless the project has them', () => {
  const registry = temp('reg')
  publish(
    write(temp('render-three-host'), {
      'shaderera.item.json': {
        name: 'render-three-host',
        type: 'component',
        category: 'Rendering',
        version: '0.1.0',
        licence: 'MIT',
        requires: { packages: { three: '0.186.1', 'fast-png': '8.0.0' } },
        files: ['src/three/host.ts'],
      },
      'src/three/host.ts': 'export const x = 1\n',
    }),
    registry,
  )
  const root = write(project(), {
    'node_modules/three/package.json': { name: 'three', version: '0.186.1' },
    'node_modules/fast-png/package.json': { name: 'fast-png', version: '7.0.0' },
  })
  const installed: string[] = []
  add(root, registry, 'render-three-host', { install: (_, spec) => installed.push(spec) })
  assert.deepEqual(installed, ['fast-png@8.0.0'])
})

test('npm keeps an exact version exact and saves @types packages as dev dependencies', () => {
  const registry = temp('reg')
  publish(
    write(temp('render-three-host'), {
      'shaderera.item.json': {
        name: 'render-three-host',
        type: 'component',
        category: 'Rendering',
        version: '0.1.0',
        licence: 'MIT',
        requires: {
          packages: { three: '0.186.1', '@types/three': '0.186.0', 'fast-png': '^8.0.0' },
        },
        files: ['src/three/host.ts'],
      },
      'src/three/host.ts': 'export const x = 1\n',
    }),
    registry,
  )
  const installed: string[][] = []
  add(project(), registry, 'render-three-host', {
    install: (_, spec, flags = []) => installed.push([spec, ...flags]),
  })
  assert.deepEqual(installed, [
    ['three@0.186.1', '--save-exact'],
    ['@types/three@0.186.0', '--save-exact', '--save-dev'],
    ['fast-png@^8.0.0'],
  ])
})

/** A component label, for the tests below. */
const piece = (name: string, files: string[], more: { [key: string]: unknown } = {}) =>
  write(temp(name), {
    'shaderera.item.json': {
      name,
      type: 'component',
      category: 'Looks',
      version: '0.1.0',
      licence: 'MIT',
      files,
      ...more,
    },
    ...Object.fromEntries(files.map((f) => [f, `// ${name} ${f}\n`])),
  })

test('a package name or range that is not one never reaches an npm command line', () => {
  const label = (packages: { [name: string]: string }) => ({
    name: 'x',
    type: 'component',
    category: 'Looks',
    version: '1.0.0',
    licence: 'MIT',
    files: ['a.ts'],
    requires: { packages },
  })
  assert.throws(() => checkItem(label({ 'x;id': '1.0.0' }), 'x'), /not a package name/)
  assert.throws(() => checkItem(label({ three: '1.0.0-$(id)' }), 'x'), /not a version range/)
  // An index from elsewhere is checked again before anything is installed.
  const registry = temp('reg')
  publish(piece('text-code-wall', ['src/code-wall.ts']), registry)
  const file = join(registry, 'index.json')
  const index = JSON.parse(readFileSync(file, 'utf8'))
  index.items['text-code-wall'].versions['0.1.0'].item.requires.packages = { three: '1 & calc' }
  writeFileSync(file, JSON.stringify(index))
  const installed: string[] = []
  assert.throws(
    () => add(project(), registry, 'text-code-wall', { install: (_, s) => installed.push(s) }),
    /not a version range/,
  )
  assert.deepEqual(installed, [])
})

test('a republish that fails leaves the published version as it was', () => {
  const registry = temp('reg')
  const dir = piece('text-code-wall', ['src/code-wall.ts'])
  publish(dir, registry)
  const label = JSON.parse(readFileSync(join(dir, 'shaderera.item.json'), 'utf8'))
  write(dir, { 'shaderera.item.json': { ...label, files: [...label.files, 'src/missing.ts'] } })
  assert.throws(() => publish(dir, registry, { force: true }), /ENOENT/)
  assert.equal(resolve(registry, 'text-code-wall').item.version, '0.1.0')
})

test('an extension publishes what npm packs, never its .npmrc or what its files leave out', () => {
  const registry = temp('reg')
  publish(
    write(temp('ext'), {
      'package.json': {
        name: '@shaderera/kinetic-type',
        version: '0.1.2',
        license: 'MIT',
        type: 'module',
        files: ['index.js'],
        shaderera: { category: 'Typography' },
      },
      'index.js': 'export const scramble = (s) => s\n',
      '.npmrc': '//registry.npmjs.org/:_authToken=secret\n',
      'notes/draft.md': 'not for anyone\n',
    }),
    registry,
  )
  const dir = join(registry, 'items', 'shaderera__kinetic-type', '0.1.2')
  assert.ok(existsSync(join(dir, 'index.js')) && existsSync(join(dir, 'package.tgz')))
  assert.ok(!existsSync(join(dir, '.npmrc')) && !existsSync(join(dir, 'notes')))
})

test('a listed file in a folder named like an output is hashed too', () => {
  const registry = temp('reg')
  publish(piece('placements', ['delivery/versions/a.json']), registry)
  writeFileSync(
    join(registry, 'items', 'placements', '0.1.0', 'delivery', 'versions', 'a.json'),
    '{}',
  )
  assert.throws(() => resolve(registry, 'placements'), /does not match its sha256/)
})

test('add resolves everything first, copies only what a piece lacks, and stops at a cycle', () => {
  const registry = temp('reg')
  publish(piece('frame', ['src/a.ts', 'src/b.ts']), registry)
  publish(piece('top', ['src/top.ts'], { requires: { items: { frame: '^0.1.0' } } }), registry)
  publish(piece('broken', ['src/broken.ts'], { requires: { items: { gone: '^1.0.0' } } }), registry)
  publish(piece('p', [], { requires: { items: { q: '*' } } }), registry)
  publish(piece('q', [], { requires: { items: { p: '*' } } }), registry)
  const root = write(project(), { 'src/a.ts': '// mine\n' })
  add(root, registry, 'top')
  assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), '// mine\n')
  assert.ok(existsSync(join(root, 'src', 'b.ts')) && existsSync(join(root, 'src', 'top.ts')))
  assert.throws(() => add(root, registry, 'broken'), /gone is not a plugin in/)
  assert.ok(!existsSync(join(root, 'src', 'broken.ts')))
  assert.doesNotThrow(() => add(root, registry, 'p'))
})

test('a release ranks above its own pre-releases', () => {
  assert.equal(newest(['0.4.0', '0.4.0-dev.1'], '*'), '0.4.0')
  assert.equal(newest(['0.4.0-dev.10', '0.4.0-dev.9'], '^0.4.0'), '0.4.0-dev.10')
})

test('search --tag matches a tag with a space', async () => {
  const registry = temp('reg')
  publish(piece('smear', ['src/smear.ts'], { tags: ['motion blur'] }), registry)
  assert.equal(search(registry, 'blur')[0]?.name, 'smear')
  const printed: string[] = []
  const log = console.log
  console.log = (s: string) => printed.push(s)
  try {
    await run('search', ['--tag', 'Motion Blur', '--json', '--from', registry])
  } finally {
    console.log = log
  }
  assert.equal(JSON.parse(printed.join('\n'))[0]?.name, 'smear')
})

test('a shaderera range that cannot be read is a problem, not ignored', () => {
  const root = write(project(), { 'shaderera.item.json': { requires: { shaderera: 'banana' } } })
  assert.deepEqual(requirementProblems(root, '0.4.0'), [
    { name: 'shaderera', range: 'banana', problem: 'not a version range' },
  ])
})

test('an item name never starts with a dot, so it stays inside items/', () => {
  for (const name of ['..', '.hidden'])
    assert.throws(
      () =>
        checkItem(
          { name, type: 'preset', category: 'Looks', version: '1.0.0', licence: 'MIT' },
          'x',
        ),
      /not a package-style name/,
    )
})

test('the index is replaced whole, never rewritten in place', () => {
  const registry = temp('reg')
  const file = join(registry, 'index.json')
  publish(piece('one', ['src/one.ts']), registry)
  const before = statSync(file, { bigint: true }).ino
  publish(piece('two', ['src/two.ts']), registry)
  assert.notEqual(statSync(file, { bigint: true }).ino, before)
  assert.ok(!existsSync(`${file}.partial`))
})

test('a file the project already has is refused, in the right number', () => {
  const registry = temp('reg')
  publish(piece('one', ['src/a.ts']), registry)
  publish(piece('two', ['src/b.ts', 'src/c.ts']), registry)
  const root = write(project(), { 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' })
  assert.throws(() => add(root, registry, 'one'), /has src\/a\.ts; use --force to replace it$/)
  assert.throws(() => add(root, registry, 'two'), /src\/c\.ts; use --force to replace them$/)
})

test('a registry served over HTTP is mirrored and added from like a folder; a path out of it is refused', async () => {
  const folder = temp('served')
  publish(piece('looks-base', ['src/base noise.ts']), folder)
  publish(
    piece('looks-grain', ['src/grain.ts'], { requires: { items: { 'looks-base': '^0.1.0' } } }),
    folder,
  )
  const server = createServer((req, res) => {
    const file = join(folder, decodeURIComponent(req.url ?? '/'))
    if (!existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end()
    res.end(readFileSync(file))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  process.env.SHADERERA_CACHE = temp('cache')
  try {
    const dir = await mirror(url, 'add', ['looks-grain'])
    assert.equal(search(dir, 'grain')[0]?.name, 'looks-grain')
    const root = project()
    add(root, dir, 'looks-grain')
    assert.ok(existsSync(join(root, 'src', 'grain.ts')))
    assert.ok(existsSync(join(root, 'src', 'base noise.ts')))

    const index = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8'))
    index.items['looks-grain'].versions['0.1.0'].files.push('../../escape.txt')
    index.items['looks-grain'].versions['0.1.0'].sha256 = 'changed'
    writeFileSync(join(folder, 'index.json'), JSON.stringify(index))
    await assert.rejects(mirror(url, 'add', ['looks-grain']), /outside its folder/)
  } finally {
    server.close()
    delete process.env.SHADERERA_CACHE
  }
})
