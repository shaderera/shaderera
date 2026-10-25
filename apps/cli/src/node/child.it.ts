import assert from 'node:assert/strict'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { buildForNode } from './build.ts'
import { openChild, TIMEOUT } from './child.ts'
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
    // Only the hung call is timed: opening has the default allowance, as in dom.it.ts.
    timeoutMs: 500,
    openTimeoutMs: TIMEOUT,
  })
  await assert.rejects(child.render(0, 'final'), /took longer than 500 ms on render at t = 0 s\./)
  await child.close()
  await assert.rejects(child.render(0, 'final'), /has exited/)
})

test("a sequential source's call outlasts timeoutMs while each frame it steps through is in time", async () => {
  const root = tempDir('steps')
  cpSync(fileURLToPath(new URL('./fixtures/sequential/', import.meta.url)), root, {
    recursive: true,
    filter: (p) => !p.includes('.shaderera'),
  })
  // 300 ms a frame: render(0.9) steps 10 frames, 3 s in one call.
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default () => ({
  render: async () => {
    await new Promise((done) => setTimeout(done, 300))
    return { color: new Uint8Array(4 * 2 * 4).fill(255), alpha: 'opaque' }
  },
})
`,
  )
  const project = await findProject(root)
  const child = await openChild(project, {
    entryFile: await buildForNode(project),
    timeoutMs: 1000,
    openTimeoutMs: TIMEOUT,
  })
  try {
    const start = performance.now()
    await child.render(0.9, 'final')
    assert.ok(performance.now() - start > 2500)
  } finally {
    await child.close()
  }
})
