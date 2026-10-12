import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildForNode } from '../node/build.ts'
import { openChild } from '../node/child.ts'
import { findProject } from '../node/project.ts'

const root = fileURLToPath(new URL('./fixtures/stamped/', import.meta.url))

const inspect = async (t: number) => {
  const project = await findProject(root)
  const child = await openChild(project, { entryFile: await buildForNode(project) })
  try {
    return (await child.inspect(t)) as Record<string, Record<string, unknown>>
  } finally {
    await child.close()
  }
}

test('a build stamps sources, and an edited literal shows up after a rebuild', async () => {
  const file = join(root, 'src/composition.ts')
  const original = readFileSync(file, 'utf8')
  try {
    const a = await inspect(0)
    assert.equal(a.back?.source, 'src/composition.ts:4:14')
    assert.equal(a.dot?.source, 'src/composition.ts:6:13')
    assert.equal(a.dot?.x, 4)
    writeFileSync(file, original.replace('x: 4,', 'x: 9,'))
    const b = await inspect(0)
    assert.equal(b.dot?.x, 9)
    assert.equal(b.dot?.source, 'src/composition.ts:6:13')
  } finally {
    writeFileSync(file, original)
  }
})
