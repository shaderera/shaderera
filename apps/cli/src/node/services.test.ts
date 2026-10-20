import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { clipDecoders, createServices, videoReader } from './services.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const clip = () => {
  const root = tempDir('video')
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10', '-frames:v', '8']
  spawnSync('ffmpeg', [...args, '-pix_fmt', 'yuv420p', join(root, 'v.mp4')])
  return root
}
const alive = (pid: number) => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

test('two video frames asked at once both arrive, each the right one', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = clip()
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

test('a closed clip has no decoder, and its frames after are the same bytes', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const v = videoReader(join(clip(), 'v.mp4'))
  try {
    const before = await v.frame(5)
    const pid = v.pid as number
    assert.ok(alive(pid))
    await v.close()
    assert.equal(v.pid, undefined)
    assert.ok(!alive(pid))
    assert.deepEqual(await v.frame(5), before)
  } finally {
    await v.close()
  }
})

test("one decoder serves every host's frames of a clip, and keeps the last few it decoded", {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = clip()
  const frame = (s: ReturnType<typeof createServices>, index: number) =>
    s.handle({ op: 'video-frame', path: 'v.mp4', index }) as Promise<Uint8Array>
  const alone = videoReader(join(root, 'v.mp4'))
  const a = createServices(root)
  const b = createServices(root)
  try {
    // Two hosts in turn, as a render on two asks: one decoder, the frames one reader gives.
    assert.deepEqual(await frame(a, 2), await alone.frame(2))
    assert.deepEqual(await frame(b, 3), await alone.frame(3))
    const [pid] = clipDecoders()
    assert.equal(clipDecoders().length, 1)
    // A little out of order (a re-check's inspect after the next frame): kept, not decoded again.
    assert.deepEqual(await frame(a, 2), await alone.frame(2))
    assert.deepEqual(clipDecoders(), [pid])
    // One host closing the clip leaves it to the other; the last one ends it.
    await a.handle({ op: 'video-close', path: 'v.mp4' })
    assert.deepEqual(await frame(b, 4), await alone.frame(4))
    assert.deepEqual(clipDecoders(), [pid])
    await b.handle({ op: 'video-close', path: 'v.mp4' })
    assert.deepEqual(clipDecoders(), [])
  } finally {
    a.close()
    b.close()
    await alone.close()
  }
})
