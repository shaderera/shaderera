import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clockOf, clockWarning } from '../cli/clock.ts'
import { buildForNode } from './build.ts'
import { openChild } from './child.ts'
import { findProject } from './project.ts'

/** A canvas source whose render reads the clock at frames from 1 s on, and whose open reads it too. */
const project = async () => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-clock-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/c.ts', fps: 10, duration: 2, width: 8, height: 8 }),
  )
  writeFileSync(
    join(root, 'src', 'c.ts'),
    `export default ({ io }) => {
      globalThis.opened = Date.now()
      const canvas = io.canvas(8, 8)
      return {
        render: async (t) => {
          // Kept: the build drops calls whose results go unused.
          if (t >= 1) globalThis.seen = [new Date(), Date.now(), performance.now(), new Date(0)]
          return { color: canvas }
        },
      }
    }`,
  )
  const found = await findProject(root)
  return openChild(found, { entryFile: await buildForNode(found), params: {} })
}

test('the Node host counts wall-clock reads inside render only, and never blocks them', async () => {
  const child = await project()
  try {
    await child.render(0.5, 'final')
    assert.deepEqual(await child.clock(), { date: 0, performance: 0 }, 'open and clean frames')
    await child.render(1, 'final')
    await child.render(1.5, 'final')
    // new Date() and Date.now() each count; new Date(0) is not the clock.
    assert.deepEqual(await child.clock(), { date: 4, performance: 2 })
    assert.deepEqual(await clockOf([child, child]), { date: 8, performance: 4 })
  } finally {
    await child.close()
  }
})

test('the warning names the reads, and there is none without them', () => {
  assert.equal(clockWarning({ date: 0, performance: 0 }), null)
  assert.match(
    clockWarning({ date: 3, performance: 1 }) ?? '',
    /read the wall clock 4 time\(s\) \(Date: 3, performance\.now: 1\)/,
  )
})
