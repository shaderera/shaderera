import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { cacheLimit, clipDecoders, createServices, keyGaps, videoReader } from './services.ts'

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

test('a frame kept when one of two hosts let the clip go is still given, not decoded past', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = tempDir('video')
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10', '-frames:v', '60']
  spawnSync('ffmpeg', [...args, '-pix_fmt', 'yuv420p', join(root, 'v.mp4')])
  const a = createServices(root)
  const b = createServices(root)
  const alone = videoReader(join(root, 'v.mp4'))
  const frame = (s: ReturnType<typeof createServices>, index: number) =>
    s.handle({ op: 'video-frame', path: 'v.mp4', index }) as Promise<Uint8Array>
  try {
    // Two hosts in turn keep 5 frames; then one closes the clip, and the other keeps 3.
    for (let i = 0; i <= 20; i++) await frame(i % 2 ? a : b, i)
    await b.handle({ op: 'video-close', path: 'v.mp4' })
    // 16 was kept under 5 and is not under 3: a new decoder reaches it (it never read on to the end).
    assert.deepEqual(await frame(a, 16), await alone.frame(16))
    assert.deepEqual(await frame(a, 21), await alone.frame(21))
  } finally {
    await a.close()
    await b.close()
    await alone.close()
  }
})

test('a decoder that cannot start fails each frame at once, and a gone thread fails the next request', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async (t) => {
  // A PATH with ffprobe and no ffmpeg: the clip is probed, its decoder cannot start.
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffprobe'], {
    encoding: 'utf8',
  })
  const probe = which.stdout.split(/\r?\n/)[0]?.trim()
  const bin = tempDir('bin')
  if (!probe) return t.skip('no ffprobe path')
  copyFileSync(probe, join(bin, basename(probe)))
  if (spawnSync(join(bin, basename(probe)), ['-version']).status !== 0)
    return t.skip('ffprobe needs files beside it')
  const file = join(clip(), 'v.mp4')
  const path = process.env.PATH
  process.env.PATH = bin
  let v: ReturnType<typeof videoReader>
  try {
    v = videoReader(file)
  } finally {
    process.env.PATH = path
  }
  await assert.rejects(v.frame(0), /could not decode/)
  const start = performance.now()
  await assert.rejects(v.frame(1), /could not decode/)
  assert.ok(performance.now() - start < 2000)
  await v.dispose()
  await assert.rejects(v.frame(2), /has stopped/)
})

test('a decoder thread that dies while it is disposed fails nothing, and leaves nothing unhandled', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const unhandled: unknown[] = []
  const note = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', note)
  try {
    const dying = new URL('./fixtures/dying-video-worker.ts', import.meta.url)
    const v = videoReader(join(clip(), 'v.mp4'), undefined, undefined, dying)
    await v.frame(0)
    await v.dispose()
    assert.match(String(v.dead), /has stopped/)
    await new Promise((done) => setTimeout(done, 100))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', note)
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

test("a clip's longest keyframe gap is known once its decoder read the packets to seek", {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = tempDir('video')
  // x264's default GOP (250) on 90 frames at 10 fps: one keyframe, 8.9 s before the last frame.
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10', '-frames:v', '90']
  const file = join(root, 'v.mp4')
  spawnSync('ffmpeg', [...args, '-pix_fmt', 'yuv420p', file])
  const v = videoReader(file)
  try {
    // From frame 0 on, nothing is seeked.
    await v.frame(0)
    await v.frame(1)
    assert.equal(keyGaps.get(file), undefined)
    // A decoder started past frame 0 reads the packets.
    await v.frame(80)
    assert.ok(Math.abs((keyGaps.get(file) ?? 0) - 8.9) < 1e-6, String(keyGaps.get(file)))
  } finally {
    await v.dispose()
  }
})

test("a draft's clips come scaled as its frame is, from a decoder of their own", {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = clip()
  const full = createServices(root)
  const draft = createServices(root, {}, { videoScale: 0.5 })
  const mean = (px: Uint8Array) => px.reduce((n, v, i) => (i % 4 === 3 ? n : n + v), 0) / px.length
  try {
    const open = (s: ReturnType<typeof createServices>) =>
      s.handle({ op: 'video-open', path: 'v.mp4' })
    const colour = { matrix: 'bt601', range: 'limited', chroma: 'left' }
    assert.deepEqual(await open(full), { width: 64, height: 36, fps: 10, frames: 8, colour })
    assert.deepEqual(await open(draft), { width: 32, height: 18, fps: 10, frames: 8, colour })
    const frame = (s: ReturnType<typeof createServices>) =>
      s.handle({ op: 'video-frame', path: 'v.mp4', index: 3 }) as Promise<Uint8Array>
    const [big, small] = [await frame(full), await frame(draft)]
    assert.equal(big.length, 64 * 36 * 4)
    assert.equal(small.length, 32 * 18 * 4)
    // The same picture, scaled by the decoder: the colours on the whole are the same.
    assert.ok(Math.abs(mean(big) - mean(small)) < 4, `${mean(big)} vs ${mean(small)}`)
    // Two decoders, one a size: neither gives the other's frames.
    assert.equal(clipDecoders().length, 2)
    const planes = (await draft.handle({
      op: 'video-frame',
      path: 'v.mp4',
      index: 3,
      format: 'yuv420p',
    })) as Uint8Array
    assert.equal(planes.length, 32 * 18 * 1.5, 'yuv420p scaled too')
  } finally {
    await full.close()
    await draft.close()
  }
})

test('a clip asked for in both formats runs a decoder for each, and one with alpha refuses yuv420p', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 30_000,
}, async () => {
  const root = clip()
  spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10', '-frames:v', '2'],
    ...['-c:v', 'png', '-pix_fmt', 'rgba', join(root, 'alpha.mov')],
  ])
  const s = createServices(root)
  try {
    const before = clipDecoders().length
    const rgba = (await s.handle({ op: 'video-frame', path: 'v.mp4', index: 1 })) as Uint8Array
    const yuv = (await s.handle({
      op: 'video-frame',
      path: 'v.mp4',
      index: 1,
      format: 'yuv420p',
    })) as Uint8Array
    assert.deepEqual([rgba.length, yuv.length], [64 * 36 * 4, 64 * 36 * 1.5])
    assert.equal(clipDecoders().length - before, 2)
    await s.handle({ op: 'video-close', path: 'v.mp4' })
    assert.equal(clipDecoders().length, before, 'both closed')
    await assert.rejects(
      s.handle({ op: 'video-frame', path: 'alpha.mov', index: 0, format: 'yuv420p' }),
      /alpha.*rgba/,
    )
    assert.equal(
      ((await s.handle({ op: 'video-frame', path: 'alpha.mov', index: 0 })) as Uint8Array).length,
      64 * 36 * 4,
    )
  } finally {
    await s.close()
  }
})
