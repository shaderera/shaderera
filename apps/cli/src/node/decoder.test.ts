import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { frameIndex, keyGap, probeIndex, seekFor, videoDecoder } from './decoder.ts'
import { probeVideo } from './services.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const probe = (packets: { pts?: number; flags: string }[], codec = 'h264', start = '0.000000') =>
  JSON.stringify({
    packets,
    streams: [{ codec_name: codec, time_base: '1/1000' }],
    format: { start_time: start },
  })

test('the frame index is the packets by pts, without the ones an edit list discards', () => {
  const index = frameIndex(
    probe([
      { pts: -80, flags: 'KD_' },
      { pts: -40, flags: '_D_' },
      { pts: 0, flags: '___' },
      { pts: 120, flags: 'K__' },
      { pts: 40, flags: '___' },
      { pts: 80, flags: '___' },
      { pts: 200, flags: 'K__' },
      { pts: 160, flags: '___' },
    ]),
  )
  assert.deepEqual(index?.pts, [0n, 40n, 80n, 120n, 160n, 200n])
  assert.deepEqual(index?.keys, [3, 5])
  // Packets that cannot say which frame is which are no index.
  assert.equal(frameIndex(probe([{ pts: 0, flags: 'K__' }, { flags: '___' }])), null)
  assert.equal(
    frameIndex(
      probe([
        { pts: 0, flags: 'K__' },
        { pts: 0, flags: '___' },
      ]),
    ),
    null,
  )
  assert.equal(frameIndex(probe([{ pts: 0, flags: 'K__' }], 'vp9')), null)
})

test('a decode for a frame starts at the keyframe before it, counted from the file start', () => {
  const pts = [0, 40, 80, 120, 160, 200].map((p) => ({ pts: p + 3300, flags: '___' }))
  for (const k of [0, 3, 5]) (pts[k] as { flags: string }).flags = 'K__'
  const index = frameIndex(probe(pts, 'h264', '3.300000'))
  assert.ok(index)
  // Frame 0, and frames before the second keyframe, decode from the start as before.
  assert.equal(seekFor(index, 0), undefined)
  assert.equal(seekFor(index, 2), undefined)
  assert.deepEqual(seekFor(index, 3), { ss: '0.120000', key: 3 })
  assert.deepEqual(seekFor(index, 4), { ss: '0.120000', key: 3 })
  assert.deepEqual(seekFor(index, 5), { ss: '0.200000', key: 5 })
  assert.equal(seekFor(index, 6), undefined)
})

/** A clip with B-frames, a keyframe every 10 frames, starting 1.5 s in, and its frames read in order. */
const clip = () => {
  const file = join(tempDir('seek'), 'v.mp4')
  const r = spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10', '-frames:v', '60'],
    ...['-c:v', 'libx264', '-bf', '3', '-g', '10', '-pix_fmt', 'yuv420p'],
    ...['-output_ts_offset', '1.5', file],
  ])
  assert.equal(r.status, 0, String(r.stderr))
  return file
}
const inOrder = async (file: string) => {
  const d = videoDecoder(
    file,
    probeVideo(file),
    () => 1,
    () => 1,
    undefined,
    null,
  )
  const frames: Uint8Array[] = []
  for (let i = 0; i < 60; i++) frames.push(await d.frame(i))
  await d.close()
  return frames
}

test('a frame given stays as it was while the decoder reads on and reuses its buffers', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 60_000,
}, async () => {
  const file = clip()
  const d = videoDecoder(file, probeVideo(file))
  try {
    const first = await d.frame(0)
    const was = first.slice()
    for (let i = 1; i < 20; i++) await d.frame(i)
    assert.deepEqual(first, was)
  } finally {
    await d.close()
  }
})

test('frames read out of order start the decoder near them and are the bytes read in order', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 60_000,
}, async () => {
  const file = clip()
  const want = await inOrder(file)
  const d = videoDecoder(
    file,
    probeVideo(file),
    () => 3,
    () => 2,
  )
  try {
    // The last frame, then jumps back and forth past keyframes and between them, then the first.
    for (const i of [59, 47, 23, 24, 25, 31, 12, 58, 40, 0, 1]) {
      assert.deepEqual(await d.frame(i), want[i], `frame ${i}`)
      assert.equal(d.seeked, i >= 10, `frame ${i} seeked`)
    }
  } finally {
    await d.close()
  }
})

test('a seeked decoder whose frame has another pts goes back to decoding from frame 0', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 60_000,
}, async () => {
  const file = clip()
  const want = await inOrder(file)
  const index = await probeIndex(file)
  assert.ok(index)
  // Each frame a pts no frame has: the first that comes out (the next) is not the one asked.
  const wrong = { ...index, pts: index.pts.map((p) => p + 1n) }
  const d = videoDecoder(
    file,
    probeVideo(file),
    () => 3,
    () => 2,
    undefined,
    wrong,
  )
  try {
    assert.deepEqual(await d.frame(35), want[35])
    assert.equal(d.seeked, false)
    assert.deepEqual(await d.frame(15), want[15])
    assert.equal(d.seeked, false)
  } finally {
    await d.close()
  }
})

test('a seeked decoder that reached the file end still seeks for a frame before', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 60_000,
}, async () => {
  const file = clip()
  const want = await inOrder(file)
  const d = videoDecoder(
    file,
    probeVideo(file),
    () => 3,
    () => 2,
  )
  try {
    assert.deepEqual(await d.frame(59), want[59])
    // Its ffmpeg ends after the last frame: the next read is a jump back, not a file that misled.
    await new Promise((done) => setTimeout(done, 500))
    assert.deepEqual(await d.frame(25), want[25])
    assert.equal(d.seeked, true)
  } finally {
    await d.close()
  }
})

/** A 9 s clip at 30 fps with a keyframe every `gop` frames. */
const gopClip = (gop: number) => {
  const file = join(tempDir('gop'), `g${gop}.mp4`)
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=30', '-t', '9']
  const x264 = ['-c:v', 'libx264', '-g', String(gop), '-sc_threshold', '0', '-pix_fmt', 'yuv420p']
  spawnSync('ffmpeg', [...args, ...x264, file])
  return file
}

test('the longest keyframe gap counts from each keyframe to the next, and the last to the end', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 60_000,
}, async () => {
  const long = await probeIndex(gopClip(250))
  const short = await probeIndex(gopClip(30))
  assert.ok(long && short)
  // Keyframes at 0 and 250: 250 frames apart (the last 20 frames are nearer).
  assert.ok(Math.abs(keyGap(long) - 250 / 30) < 1e-6, String(keyGap(long)))
  assert.ok(Math.abs(keyGap(short) - 1) < 1e-6, String(keyGap(short)))
  // Only the last stretch: one keyframe, 10 frames after it.
  const one = frameIndex(
    probe([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((pts) => ({ pts, flags: pts ? '___' : 'K__' }))),
  )
  assert.ok(one)
  assert.equal(keyGap(one), 0.01)
  // And the first stretch: frames before the first keyframe (an edit list that starts mid-GOP).
  const late = frameIndex(
    probe([0, 1, 2, 3, 4, 5, 6].map((pts) => ({ pts, flags: pts === 5 ? 'K__' : '___' }))),
  )
  assert.ok(late)
  assert.equal(keyGap(late), 0.005)
})
