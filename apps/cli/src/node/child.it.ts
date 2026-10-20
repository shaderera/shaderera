import assert from 'node:assert/strict'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { buildForNode } from './build.ts'
import { openChild } from './child.ts'
import { findProject } from './project.ts'

const tiny = fileURLToPath(new URL('./fixtures/tiny/', import.meta.url))

test('a hung source fails the call after timeoutMs and closes without a crash', async () => {
  const root = tempDir('hang')
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
