import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Manifest } from '@shaderera/core'
import { boxFrame, memoryChild } from '../node/fixtures/memory-child.ts'
import { checkChild, diffP010, keyframeNotes } from './check.ts'

const manifest = { fps: 10, duration: 1, width: 64, height: 36 } as Manifest
const size = { width: 64, height: 36 }

const hdr10 = {
  graphicsWhite: 203,
  mastering: { peak: 1000, min: 0.005, primaries: 'p3-d65' as const },
  dither: 'tpdf' as const,
}

test('an hdr10 check hashes P010, reports the light, and fails a frame past the peak', async () => {
  const film = memoryChild({ size, frame: boxFrame(64, 36), hdr: { hdr10, fps: 10 } })
  assert.equal(film.has.p010, true)
  assert.equal(film.has.yuv, false)
  const ok = await checkChild(film, manifest, { samples: 4 })
  assert.deepEqual(ok.failures, [])
  // An opaque red box over transparent black: BT.709 red at Graphics White is R 0.627 × 203 in BT.2020.
  assert.ok(ok.light && Math.abs(ok.light.maxCll - 0.6274 * 203) < 2, JSON.stringify(ok.light))
  assert.ok(ok.light.maxFall > 0 && ok.light.maxFall < ok.light.maxCll)
  assert.deepEqual(ok.previewVsFinal, { mean: 0, max: 0, at: ok.previewVsFinal.at })
  // A display whose peak is below that red: the frame passes it.
  const dim = { ...hdr10, mastering: { ...hdr10.mastering, peak: 100 } }
  const over = memoryChild({ size, frame: boxFrame(64, 36), hdr: { hdr10: dim, fps: 10 } })
  await assert.rejects(
    checkChild(over, manifest, { samples: 2 }),
    /above the mastering display's peak of 100 cd\/m²/,
  )
  // An hdr10 host gives nothing in SDR.
  await assert.rejects(
    film.render(0, 'final'),
    /An hdr10 render comes out as rgb10 or p010, not rgba/,
  )
})

test('a check of fewer than two timestamps is refused: it could never fail', async () => {
  const child = memoryChild({ size })
  for (const times of [0, 1, Number.NaN, 2.5])
    await assert.rejects(checkChild(child, manifest, { samples: times }), /2 or more/)
})

test('check passes a film that is a function of t, inspect included, and fails one with state', async () => {
  const film = memoryChild({ size, frame: boxFrame(64, 36), inspect: (t) => ({ x: 20 - 10 * t }) })
  const ok = await checkChild(film, manifest, { samples: 5 })
  assert.deepEqual(ok.failures, [])
  assert.equal(ok.what, 'inspect + pixels')
  assert.deepEqual(ok.previewVsFinal, { mean: 0, max: 0, at: ok.previewVsFinal.at })
  assert.equal(ok.seeks, null)

  // Each frame a little brighter than the one before: a revisit gives other pixels.
  let n = 0
  const stateful = memoryChild({ size, frame: () => new Uint8Array(64 * 36 * 4).fill(n++) })
  const bad = await checkChild(stateful, manifest, { samples: 5 })
  assert.ok(bad.failures.length > 0)
  assert.equal(bad.what, 'pixels')
})

test('diffP010 compares P010 bytes that start at an odd offset', () => {
  // A Node Buffer can hand back bytes at any offset of its pool: view those, copy these.
  const words = new Uint16Array([0, 512 << 6, 1023 << 6, 64 << 6])
  const odd = new Uint8Array(words.byteLength + 1)
  odd.set(new Uint8Array(words.buffer), 1)
  const a = odd.subarray(1)
  assert.equal(a.byteOffset % 2, 1)
  assert.deepEqual(diffP010(a, new Uint8Array(words.buffer)), { mean: 0, max: 0 })
  const b = new Uint16Array([1 << 6, 512 << 6, 1023 << 6, 60 << 6])
  assert.deepEqual(diffP010(a, new Uint8Array(b.buffer)), { mean: 5 / 4, max: 4 })
})

test("check notes the project's own clips whose keyframes are more than 2 s apart", () => {
  const root = join('/films', 'a')
  const gaps = new Map([
    [join(root, 'assets', 'footage', 'long.mp4'), 250 / 30],
    [join(root, 'assets', 'footage', 'short.mp4'), 1],
    [join(root, 'assets', 'footage', 'two.mp4'), 2],
    [join(root, '..clip.mp4'), 3],
    [join(root, 'node_modules', 'pkg', 'clip.mp4'), 9],
    [join('/films', 'b', 'other.mp4'), 9],
  ])
  const note = (path: string, s: string) =>
    `${path}: keyframes up to ${s} s apart, so every seek in it (check, still, the studio scrub, a chunk start) decodes up to ${s} s of frames first. Trim it with a short GOP (-g <fps>, docs/guides/footage.md).`
  // A file named ..clip.mp4 is inside; an installed package's clip is not the project's own.
  assert.deepEqual(keyframeNotes(root, gaps), [
    note('assets/footage/long.mp4', '8.3'),
    note('..clip.mp4', '3.0'),
  ])
})
