import assert from 'node:assert/strict'
import { cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { buildForNode } from './build.ts'
import { openChild, TIMEOUT } from './child.ts'
import { findProject } from './project.ts'

/**
 * A call that makes a pipeline has the open's allowance; one that compiles nothing has timeoutMs.
 * Needs a GPU: without one this fails, it does not skip (as gpu-loss.it.ts).
 */
// A copy beside a link to the `webgpu` (Dawn) fixtures/particles installs, as gpu-loss.it.ts.
const root = join(tempDir('compile'), 'film')
cpSync(join(import.meta.dirname, 'fixtures', 'compile'), root, { recursive: true })
mkdirSync(join(root, 'node_modules'))
symlinkSync(
  realpathSync(join(import.meta.dirname, '../../fixtures/particles/node_modules/webgpu')),
  join(root, 'node_modules', 'webgpu'),
  'junction',
)
const project = await findProject(root)
const entryFile = await buildForNode(project)

test('a frame that compiles outlasts timeoutMs; a later hung frame fails at timeoutMs, naming t', async () => {
  const child = await openChild(project, {
    entryFile,
    params: { hang: true },
    timeoutMs: 1000,
    openTimeoutMs: TIMEOUT,
  })
  try {
    // 1.5 s after its pipeline: past timeoutMs, inside the open's allowance.
    await child.render(0, 'final')
    await assert.rejects(
      child.render(0.5, 'final'),
      /took longer than 1000 ms on render at t = 0\.5 s/,
    )
  } finally {
    await child.close()
  }
})
