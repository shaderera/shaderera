import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServices } from './services.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

test('two video frames asked at once both arrive, each the right one', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-video-'))
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10', '-frames:v', '8']
  spawnSync('ffmpeg', [...args, '-pix_fmt', 'yuv420p', join(root, 'v.mp4')])
  const frames = async (s: ReturnType<typeof createServices>, ...at: number[]) =>
    Promise.all(at.map((index) => s.handle({ op: 'video-frame', path: 'v.mp4', index })))
  const together = createServices(root)
  const one = createServices(root)
  try {
    const [a, b] = await frames(together, 2, 4)
    assert.deepEqual(a, (await frames(one, 2))[0])
    assert.deepEqual(b, (await frames(one, 4))[0])
    assert.notDeepEqual(a, b)
  } finally {
    together.close()
    one.close()
  }
})
