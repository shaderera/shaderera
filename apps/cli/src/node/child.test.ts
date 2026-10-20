import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256 } from '@shaderera/core/host'
import { buildForNode } from './build.ts'
import { openChild, permissionArgs } from './child.ts'
import { findProject } from './project.ts'

const tiny = fileURLToPath(new URL('./fixtures/tiny/', import.meta.url))

test('permissionArgs widens packages to their node_modules and drops nested directories', () => {
  const root = resolve('/w/app')
  const modules = resolve('/w/node_modules')
  const args = permissionArgs(root, [
    join(modules, '.pnpm/a@1/node_modules/a'),
    join(modules, '.pnpm/b@1/node_modules/b'),
    join(root, 'node_modules/c'),
    resolve('/w/packages/core'),
  ])
  assert.deepEqual(args.slice(0, 2), ['--permission', '--allow-addons'])
  assert.deepEqual(
    args.filter((a) => a.startsWith('--allow-fs-read=')),
    [root, modules, resolve('/w/packages/core')].map((d) => `--allow-fs-read=${d}`),
  )
  assert.ok(!args.some((a) => /fs-write|child-process/.test(a)))
})

test('a root below an npm project reads the flat node_modules, platform packages included', () => {
  // npm puts @napi-rs/canvas-<platform> beside @napi-rs/canvas, not inside it.
  const project = resolve('/p/film')
  const root = join(project, 'stateful')
  const args = permissionArgs(root, [
    join(project, 'node_modules/shaderera'),
    join(project, 'node_modules/@napi-rs/canvas'),
  ])
  assert.deepEqual(
    args.filter((a) => a.startsWith('--allow-fs-read=')),
    [root, join(project, 'node_modules')].map((d) => `--allow-fs-read=${d}`),
  )
})

test('permissionArgs keeps two directories on different drives', () => {
  const [a, b] =
    process.platform === 'win32' ? [String.raw`C:\tools`, String.raw`D:\film`] : ['/tools', '/film']
  assert.deepEqual(
    permissionArgs(a, [b]).filter((x) => x.startsWith('--allow-fs-read=')),
    [a, b].map((d) => `--allow-fs-read=${d}`),
  )
})

test('the child renders deterministically and cannot write or spawn', async () => {
  const project = await findProject(tiny)
  const entryFile = await buildForNode(project)
  const child = await openChild(project, { entryFile })
  try {
    const a = await child.render(0.5, 'final')
    assert.equal(a.pixels.length, 64 * 36 * 4)
    assert.deepEqual(a.layers, [{ name: 'back' }, { name: 'square' }])
    assert.equal(await sha256(a.pixels), await sha256((await child.render(0.5, 'final')).pixels))
    assert.deepEqual(await child.inspect(0), {
      back: { red: 0, source: 'src/composition.ts:10:7' },
      square: { position: [8, 8], size: 16 },
    })
    assert.equal(await child.camera(0), null)
  } finally {
    await child.close()
  }
  for (const code of [
    `require('fs').writeFileSync(${JSON.stringify(join(tiny, 'x.txt'))}, 'x')`,
    `require('child_process').spawnSync('node', ['-v'])`,
  ]) {
    const r = spawnSync(process.execPath, [...permissionArgs(tiny, []), '-e', code], {
      encoding: 'utf8',
    })
    assert.match(r.stderr, /ERR_ACCESS_DENIED/)
  }
  assert.ok(!existsSync(join(tiny, 'x.txt')))
})

test('a hung source fails the call after timeoutMs and closes without a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-hang-'))
  cpSync(tiny, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    'export default () => ({ render: async () => { for (;;) {} } })\n',
  )
  const project = await findProject(root)
  const child = await openChild(project, {
    entryFile: await buildForNode(project),
    timeoutMs: 5000,
  })
  await assert.rejects(child.render(0, 'final'), /took longer than 5000 ms/)
  await child.close()
  await assert.rejects(child.render(0, 'final'), /has exited/)
})
