import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildForNode } from './build.ts'
import { openChild } from './child.ts'
import { findProject } from './project.ts'

const tiny = fileURLToPath(new URL('./fixtures/tiny/', import.meta.url))
const bin = fileURLToPath(new URL('../../bin/shaderera.js', import.meta.url))

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

test('the CLI inspects, checks and renders the tiny project', () => {
  // A copy: render saves a revision into the project it renders.
  const root = mkdtempSync(join(tmpdir(), 'shaderera-tiny-'))
  cpSync(tiny, root, { recursive: true, filter: (f) => !/[/](out|\.shaderera|versions)$/.test(f) })
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' })
  const inspect = cli('inspect', '--time', '0.5')
  assert.equal(inspect.status, 0, inspect.stderr)
  assert.match(inspect.stdout, /square\.position \[18, 8\]/)
  const check = cli('check', '--times', '5')
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /✓ deterministic: 5 timestamps/)
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return
  const out = join(root, 'out', `${basename(root)}.mp4`)
  const render = cli('render')
  assert.equal(render.status, 0, render.stderr)
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      out,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(probe.stdout.trim(), '10')
})
