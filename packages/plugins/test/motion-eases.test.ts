// motion-eases: copied into a project the way `add` lays it out. The eases give the values they
// gave in motion-keyframes, and `envelope` with the old options gives exactly what
// audio-beat-clock's `pulse` and camera-shake's `hits` gave (copied here as they were).

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'motion-eases')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'motion-eases', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'motion-eases', f), join(project, f))
}
const E = (await import(
  pathToFileURL(join(project, 'src/motion/eases.ts')).href
)) as typeof import('../motion-eases/src/motion/eases.ts')

const U = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]
/** What motion-keyframes 0.1.1's eases gave at U. */
const BEFORE: [string, (u: number) => number, number[]][] = [
  ['linear', E.linear, [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]],
  ['smooth', E.smooth, [0, 0.028, 0.15625, 0.5, 0.84375, 0.972, 1]],
  ['strike', E.strike, [0, 0.3439, 0.68359375, 0.9375, 0.99609375, 0.9999, 1]],
  ['accel', E.accel, [0, 0.001, 0.015625, 0.125, 0.421875, 0.729, 1]],
  ['glide', E.glide, [0, 0.004, 0.0625, 0.5, 0.9375, 0.996, 1]],
  ['hold', E.hold, [0, 0, 0, 0, 0, 0, 1]],
  [
    'sine',
    E.sine,
    [0, 0.024471741852423234, 0.1464466094067262, 0.5, 0.8535533905932737, 0.9755282581475768, 1],
  ],
  ['expo', E.expo, [0, 0.001953125, 0.015625, 0.5, 0.984375, 0.998046875, 1]],
  [
    'circ',
    E.circ,
    [0, 0.010102051443364402, 0.0669872981077807, 0.5, 0.9330127018922193, 0.9898979485566356, 1],
  ],
  ['back(2.4)', E.back(2.4), [0, 0.4654, 0.915625, 1.175, 1.096875, 1.0206, 1]],
  [
    'settle(8)',
    E.settle(8),
    [
      0, 0.19178690062813913, 0.5957929466984291, 0.9111727853096281, 0.9856244964165725,
      0.9968877636716376, 1,
    ],
  ],
  [
    'bezier(0.8, 0, 0.2, 1)',
    E.bezier(0.8, 0, 0.2, 1),
    [0, 0.00592439390363274, 0.047643803060876504, 0.5, 0.9523561969391234, 0.9940756060963672, 1],
  ],
]

test('motion-eases: the eases give the values they gave in motion-keyframes', () => {
  for (const [name, ease, want] of BEFORE)
    for (const [i, u] of U.entries())
      assert.ok(Math.abs(ease(u) - (want[i] ?? 0)) < 1e-12, `${name}(${u}) is ${ease(u)}`)
  assert.equal(E.progress(5, 4, 6), 0.5)
  assert.equal(E.progress(3, 4, 6), 0)
  assert.equal(E.progress(9, 4, 6), 1)
  assert.equal(E.progress(4.5, 4, 6, E.linear), 0.25)
  assert.equal(E.clamp(2), 1)
  assert.equal(E.clamp(-3, -1, 1), -1)
  assert.equal(E.lerp(10, 20, 0.25), 12.5)
})

// audio-beat-clock 0.1.1's `pulse`, as it was.
const pulse = (t: number, times: readonly number[], decay = 0.12) => {
  let last = Number.NEGATIVE_INFINITY
  for (const x of times) if (x <= t && x > last) last = x
  return Number.isFinite(last) ? Math.exp(-(t - last) / decay) : 0
}
// camera-shake 0.1.0's `hit` and `hits`, as they were.
const hit = (t: number, at: number, decay = 0.25) => (t < at ? 0 : Math.exp(-(t - at) / decay))
const hits = (t: number, times: readonly number[], decay = 0.25) =>
  Math.min(
    1.5,
    times.reduce((s, at) => s + hit(t, at, decay), 0),
  )

test('motion-eases: envelope with the old options is exactly pulse and hits', () => {
  const times = [0.3, 0.32, 1.1, 0.9, 2, 2.03, 2.06, 2.09, 3]
  for (let i = -100; i <= 400; i++) {
    const t = i / 100
    assert.equal(E.envelope(t, times, { combine: 'last', decay: 0.12 }), pulse(t, times))
    assert.equal(E.envelope(t, times, { combine: 'last', decay: 0.07 }), pulse(t, times, 0.07))
    assert.equal(E.envelope(t, times, { combine: 'sum', decay: 0.25, limit: 1.5 }), hits(t, times))
    assert.equal(
      E.envelope(t, times, { combine: 'sum', decay: 0.3, limit: 1.5 }),
      hits(t, times, 0.3),
    )
    assert.equal(E.envelope(t, [1], { combine: 'sum', decay: 0.25, limit: 1.5 }), hit(t, 1))
  }
  assert.ok(hits(2.09, times) === 1.5, 'the times reach the old cap')
})

test('motion-eases: envelope by default takes the strongest hit, and ramps in over attack', () => {
  assert.equal(E.envelope(0.5, [1]), 0)
  assert.equal(E.envelope(1, [1]), 1)
  assert.equal(E.envelope(1.25, [1], { decay: 0.25 }), Math.exp(-1))
  assert.equal(E.envelope(1.25, [1], { attack: 0.5 }), 0.5)
  assert.equal(E.envelope(1.5, [1], { attack: 0.5 }), 1)
  assert.equal(E.envelope(1.75, [1], { attack: 0.5, decay: 0.25 }), Math.exp(-1))
  // A new hit still ramping in: 'max' keeps the tail of the one before, 'last' drops to the ramp.
  assert.equal(E.envelope(1.25, [1, 1.125], { attack: 0.5 }), 0.5)
  assert.equal(E.envelope(1.25, [1, 1.125], { attack: 0.5, combine: 'last' }), 0.25)
  assert.equal(E.envelope(1, [1, 1, 1], { combine: 'sum', limit: 2 }), 2)
})
