import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256 } from '@shaderera/core'
import { tempDir } from '../fixtures/temp.ts'
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

test('the child refuses a native addon outside node_modules, such as one io.cache wrote', async () => {
  const root = tempDir('dlopen')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, '.shaderera', 'cache'), { recursive: true })
  writeFileSync(join(root, '.shaderera', 'cache', 'evil.node'), 'not an addon')
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/c.ts', fps: 10, duration: 1, width: 8, height: 8 }),
  )
  writeFileSync(
    join(root, 'src', 'c.ts'),
    `export default ({ io }) => {
      let error = ''
      try {
        process.dlopen({ exports: {} }, ${JSON.stringify(join(root, '.shaderera', 'cache', 'evil.node'))})
      } catch (e) {
        error = e.message
      }
      const canvas = io.canvas(8, 8)
      return { render: async () => ({ color: canvas }), inspect: async () => ({ error }) }
    }`,
  )
  const project = await findProject(root)
  const child = await openChild(project, { entryFile: await buildForNode(project), params: {} })
  try {
    assert.match(JSON.stringify(await child.inspect(0)), /outside node_modules is refused/)
  } finally {
    await child.close()
  }
})

test('the child opens an hdr10 range only for a film with hdr10, and never on Skia', async () => {
  const project = await findProject(tiny)
  const entryFile = await buildForNode(project)
  await assert.rejects(
    openChild(project, { entryFile, range: 'hdr10' }),
    /An hdr10 render needs the hdr10 block in shaderera\.json/,
  )
  // tiny installs no `webgpu`: the Node host composites with Skia, in SDR only.
  const hdr10 = { mastering: { peak: 1000, min: 0.005, primaries: 'p3-d65' }, dither: 'none' }
  await assert.rejects(
    openChild(
      { ...project, manifest: { ...project.manifest, hdr10 } as typeof project.manifest },
      { entryFile, range: 'hdr10' },
    ),
    /needs a GPUDevice in every host, and this one has none: .*Skia path is SDR only/,
  )
})
