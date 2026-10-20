import assert from 'node:assert/strict'
import { cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { openBrowserChild } from './browser.ts'
import { buildForNode } from './build.ts'
import { type Child, openChild } from './child.ts'
import { findProject } from './project.ts'

/**
 * A lost GPU device (fixtures/gpu-loss destroys it once, as a driver reset would) fails the call
 * it happened in, never returns its frame, and the next call reopens the source on a new device,
 * in both hosts. Needs a GPU and Chrome; without them these fail, they do not skip.
 */
// A copy beside a link to the `webgpu` (Dawn) fixtures/particles installs: the Node host loads the
// project's own.
const root = join(tempDir('gpu-loss'), 'film')
cpSync(join(import.meta.dirname, 'fixtures', 'gpu-loss'), root, { recursive: true })
mkdirSync(join(root, 'node_modules'))
symlinkSync(
  realpathSync(join(import.meta.dirname, '../../fixtures/particles/node_modules/webgpu')),
  join(root, 'node_modules', 'webgpu'),
  'junction',
)
const project = await findProject(root)
const entryFile = await buildForNode(project)

for (const [host, open] of [
  ['node', (params = {}) => openChild(project, { entryFile, params })],
  ['browser', (params = {}) => openBrowserChild(project, { params })],
] as [string, (params?: { mode?: string }) => Promise<Child>][]) {
  test(`${host}: a WebGPU error during a render fails it, though the frame came back`, async () => {
    const child = await open({ mode: 'invalid' })
    try {
      await child.render(0.2, 'final')
      // The compiler's own message, line and column, not the pipelines it broke.
      await assert.rejects(
        child.render(0.6, 'final'),
        /1 shader error\(s\) during this call[\s\S]*WGSL error in a shader at 1:1: [\s\S]*not wgsl/,
      )
    } finally {
      await child.close()
    }
  })

  test(`${host}: a lost device fails that render; the next one reopens and renders`, async () => {
    const child = await open()
    try {
      const first = await child.render(0.2, 'final')
      assert.deepEqual([...first.pixels.subarray(0, 4)], [20, 20, 20, 255])
      await assert.rejects(child.render(0.6, 'final'), /lost|destroyed/i)
      const again = await child.render(0.6, 'final')
      assert.deepEqual([...again.pixels.subarray(0, 4)], [60, 60, 60, 255])
    } finally {
      await child.close()
    }
  })
}
