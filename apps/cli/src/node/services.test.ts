import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { cacheLimit, clipDecoders, createServices, videoReader } from './services.ts'

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

test('a jump far ahead starts a new decoder at the frame, a short one reads on; the bytes are the same', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = tempDir('video')
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10', '-frames:v', '90']
  spawnSync('ffmpeg', [...args, '-pix_fmt', 'yuv420p', join(root, 'v.mp4')])
  const v = videoReader(join(root, 'v.mp4'))
  const fresh = videoReader(join(root, 'v.mp4'))
  try {
    await v.frame(2)
    const first = v.pid
    // 2 → 20: read on through the frames between.
    await v.frame(20)
    assert.equal(v.pid, first)
    // 20 → 80: past half of where it is, so ffmpeg skips the frames before 80 itself.
    const far = await v.frame(80)
    assert.notEqual(v.pid, first)
    assert.deepEqual(far, await fresh.frame(80))
    assert.deepEqual(await v.frame(81), await fresh.frame(81))
  } finally {
    await v.close()
    await fresh.close()
  }
})

const key = (c: string) => c.repeat(64)
const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill)

test('past its limit the cache drops the least recently used entries, a get counting as a use', async () => {
  const root = tempDir('cache')
  const s = createServices(root, {}, { cacheLimit: 3000 })
  const dir = join(root, '.shaderera', 'cache')
  const put = (c: string) => s.handle({ op: 'cache-put', hash: key(c), bytes: bytes(1000, 1) })
  const get = (c: string) => s.handle({ op: 'cache-get', hash: key(c) })
  // a, b and c put in that order, a minute apart: a is the oldest.
  for (const [i, c] of ['a', 'b', 'c'].entries()) {
    await put(c)
    const at = new Date(Date.now() - (3 - i) * 60_000)
    utimesSync(join(dir, key(c)), at, at)
  }
  // Another host is writing an entry: its temporary file is never counted or removed.
  writeFileSync(join(dir, `${key('e')}.99999`), bytes(5000, 2))
  // Using a makes b the least recently used.
  assert.deepEqual(await get('a'), bytes(1000, 1))
  await put('d')
  assert.equal(await get('b'), null)
  for (const c of ['a', 'c', 'd']) assert.deepEqual(await get(c), bytes(1000, 1), c)
  assert.ok(existsSync(join(dir, `${key('e')}.99999`)))
  // The film makes b again, and it is kept: the newest are kept, the total stays under the limit.
  await put('b')
  assert.deepEqual(await get('b'), bytes(1000, 1))
  const kept = readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/.test(n))
  assert.equal(kept.length, 3)
})

test('an entry larger than the limit is kept alone, and the limit comes from the environment', async () => {
  const root = tempDir('cache')
  const s = createServices(root, {}, { cacheLimit: 1500 })
  await s.handle({ op: 'cache-put', hash: key('a'), bytes: bytes(1000, 1) })
  await s.handle({ op: 'cache-put', hash: key('b'), bytes: bytes(2000, 1) })
  assert.equal(await s.handle({ op: 'cache-get', hash: key('a') }), null)
  assert.deepEqual(await s.handle({ op: 'cache-get', hash: key('b') }), bytes(2000, 1))
  assert.equal(cacheLimit({}), 1024 * 1024 * 1024)
  assert.equal(cacheLimit({ SHADERERA_FILM_CACHE_MB: '200' }), 200 * 1024 * 1024)
  assert.throws(() => cacheLimit({ SHADERERA_FILM_CACHE_MB: 'lots' }), /SHADERERA_FILM_CACHE_MB/)
})
