import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkDeterminism, frameTimes } from '@shaderera/core'
import { buildForNode } from './build.ts'
import { openChild } from './child.ts'
import { findProject } from './project.ts'

test('a sequential source is replayed from 0 when the host goes back in t', async () => {
  const project = await findProject(join(import.meta.dirname, 'fixtures', 'sequential'))
  const child = await openChild(project, { entryFile: await buildForNode(project) })
  try {
    const report = await checkDeterminism({
      times: frameTimes(10, 0, 1),
      render: async (t) => (await child.render(t, 'final')).pixels,
      inspect: (t) => child.inspect(t),
    })
    assert.deepEqual(report.failures, [])
    // The same t again, and inspect before render: both as if stepped there from frame 0.
    for (const t of [0.4, 0.4, 0.2]) {
      assert.deepEqual(await child.inspect(t), { t, frames: Math.round(t * 10) + 1 })
      assert.equal((await child.render(t, 'final')).pixels[0], (Math.round(t * 10) + 1) * 10)
    }
  } finally {
    await child.close()
  }
})
