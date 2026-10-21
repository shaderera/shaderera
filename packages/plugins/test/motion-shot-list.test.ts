// motion-shot-list: copied into a project the way `add` lays it out, then the shots, transitions
// and source frames at t checked against tables worked out in whole numbers.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'motion-shot-list')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'motion-shot-list', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'motion-shot-list', f), join(project, f))
}
const { shotAt, shotList } = (await import(
  pathToFileURL(join(project, 'src/motion/shot-list.ts')).href
)) as typeof import('../motion-shot-list/src/motion/shot-list.ts')

test('a 23.976 fps source in a 25 fps film: the shot and frame at every frame match the table', () => {
  // Footage reports 24000/1001 as a float; the fraction string is the same rate.
  const list = shotList([
    { id: 'a', dur: 41, src: 'a.mp4', fps: 24000 / 1001 },
    { id: 'b', dur: 3, transition: 0.4, src: 'b.mp4', fps: '24000/1001', in: 1.5 },
    { id: 'c', dur: 2, src: 'a.mp4', fps: 23.976, in: 10 },
  ])
  assert.equal(list.duration, 45.6)
  // In film frames at 25: a is 0–1025, b 1015–1090 (in = 37.5 frames), c 1090–1140 (in = 250).
  // Source frame = floor((in + k) × 24000 / (25 × 1001)), k film frames since the cut, in halves
  // to keep b's 37.5 whole.
  const src = (inHalves: number, k: number) =>
    Math.floor(((inHalves + 2 * k) * 24000) / (2 * 25 * 1001))
  const table: { shot: string; frame: number; leaving?: string; leavingFrame?: number }[] = []
  for (let i = 0; i < 1140; i++) {
    if (i < 1015) table.push({ shot: 'a', frame: src(0, i) })
    else if (i < 1025)
      table.push({ shot: 'b', frame: src(75, i - 1015), leaving: 'a', leavingFrame: src(0, i) })
    else if (i < 1090) table.push({ shot: 'b', frame: src(75, i - 1015) })
    else table.push({ shot: 'c', frame: src(500, i - 1090) })
  }
  // A few rows by hand: frame 960 starts exactly at film frame 1001 (40.04 s).
  assert.deepEqual(
    [0, 1, 2, 3, 1000, 1001].map((i) => table[i]!.frame),
    [0, 0, 1, 2, 959, 960],
  )
  for (let i = 0; i < 1140; i++) {
    const at = shotAt(list, i / 25)
    const row = table[i]!
    assert.equal(at.shot.shot.id, row.shot, `film frame ${i}`)
    assert.equal(at.shot.frame, row.frame, `film frame ${i}`)
    assert.equal(at.leaving?.shot.id, row.leaving, `film frame ${i}`)
    assert.equal(at.leaving?.frame, row.leavingFrame, `film frame ${i}`)
  }
})

test('source frames floor at frame boundaries, at an NTSC rate for a long time', () => {
  const list = shotList([{ id: 'a', dur: 4000, fps: '30000/1001' }])
  for (let i = 0; i < 100_000; i += 7) {
    const t = (i * 1001) / 30000
    assert.equal(shotAt(list, t).shot.frame, i, `frame ${i}`)
    assert.equal(shotAt(list, t + 0.5 * (1001 / 30000)).shot.frame, i, `half way through ${i}`)
    if (i > 0) assert.equal(shotAt(list, t - 1e-4).shot.frame, i - 1, `just before ${i}`)
  }
})

test('speed 2, a freeze and reverse give the expected frames', () => {
  const list = shotList([
    { id: 'fast', dur: 2, fps: 24, speed: 2 },
    { id: 'freeze', dur: 2, fps: 24, in: 3, hold: 1.5 },
    { id: 'back', dur: 2, fps: 24, in: 2, speed: -1 },
  ])
  const frames = (from: number) =>
    Array.from({ length: 48 }, (_, k) => shotAt(list, from + k / 24).shot.frame)
  // Twice as fast: every other frame.
  assert.deepEqual(
    frames(0),
    Array.from({ length: 48 }, (_, k) => 2 * k),
  )
  // From 3 s (frame 72), moving for 0.5 s, then held on the frame reached.
  assert.deepEqual(
    frames(2),
    Array.from({ length: 48 }, (_, k) => 72 + Math.min(k, 12)),
  )
  // Backwards from 2 s: frame 47 first, each for a whole frame, down to 0.
  assert.deepEqual(
    frames(4),
    Array.from({ length: 48 }, (_, k) => 47 - k),
  )
  assert.equal(shotAt(list, 4 + 0.5 / 24).shot.frame, 47)
  assert.equal(shotAt(list, 2.5).shot.progress, 0.25)
  assert.equal(shotAt(list, 2.5).shot.local, 0.5)
})

test('the transition goes from 0 to 1 across a join, and the shot before is shown until then', () => {
  const list = shotList([
    { id: 'a', dur: 2 },
    { id: 'b', dur: 2, transition: 0.5 },
  ])
  assert.deepEqual(
    list.shots.map((s) => [s.start, s.end]),
    [
      [0, 2],
      [1.5, 3.5],
    ],
  )
  assert.equal(shotAt(list, 1.49).leaving, undefined)
  assert.equal(shotAt(list, 1.49).transition, 1)
  let last = -1
  for (let i = 0; i < 15; i++) {
    const at = shotAt(list, 1.5 + i / 30)
    assert.equal(at.shot.shot.id, 'b')
    assert.equal(at.leaving?.shot.id, 'a')
    assert.ok(at.transition >= 0 && at.transition < 1 && at.transition > last)
    last = at.transition
  }
  assert.equal(shotAt(list, 1.5).transition, 0)
  assert.equal(shotAt(list, 1.75).transition, 0.5)
  assert.equal(shotAt(list, 2).leaving, undefined)
  assert.equal(shotAt(list, 2).transition, 1)
  // Outside the film: the first shot, and the last.
  assert.equal(shotAt(list, -1).shot.shot.id, 'a')
  assert.equal(shotAt(list, 9).shot.shot.id, 'b')
})

test('closeAt is when each source is last on screen', () => {
  const list = shotList([
    { id: 'a', dur: 2, src: 'x.mp4' },
    { id: 'b', dur: 2, src: 'y.mp4', transition: 1 },
    { id: 'c', dur: 2, src: 'x.mp4' },
    { id: 'd', dur: 2 },
  ])
  assert.deepEqual(list.closeAt, { 'x.mp4': 5, 'y.mp4': 3 })
})

test('a list that cannot play says why', () => {
  assert.throws(() => shotList([{ id: 'a', dur: 0 }]), /Shot 0 "a": dur must be above 0/)
  assert.throws(
    () => shotList([{ id: 'a', dur: 1, transition: 0.5 }]),
    /no shot before it to transition from/,
  )
  assert.throws(
    () =>
      shotList([
        { id: 'a', dur: 1 },
        { id: 'b', dur: 2, transition: 1.5 },
      ]),
    /longer than it or the shot before/,
  )
  assert.throws(
    () =>
      shotList([
        { id: 'a', dur: 2 },
        { id: 'b', dur: 1, transition: 0.8 },
        { id: 'c', dur: 2, transition: 0.8 },
      ]),
    /starts before "a" ends/,
  )
  assert.throws(() => shotList([{ id: 'a', dur: 1, hold: 2 }]), /hold must be from 0 to dur/)
  assert.throws(() => shotList([{ id: 'a', dur: 1, fps: '24/0' }]), /fps must be/)
  assert.throws(() => shotAt(shotList([]), 0), /empty/)
})
