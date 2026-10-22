import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { exportVideo } from './render.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

test('render refuses a source that is not deterministic and leaves no file', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject()
  // Each frame a little brighter than the one before: a revisit gives other pixels.
  let n = 0
  const child = memoryChild({
    size: { width: 64, height: 36 },
    frame: () => new Uint8Array(64 * 36 * 4).fill(n++ % 256),
  })
  const out = join(project.root, 'out', 'refused.mp4')
  await assert.rejects(
    exportVideo(project, child, { out, revision: 'test' }),
    /Not exported: the source is not deterministic \(t=[\d.]+ after t=[\d.]+: pixels/,
  )
  assert.equal(existsSync(out), false)
})
