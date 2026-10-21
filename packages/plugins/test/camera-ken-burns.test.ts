// camera-ken-burns: copied into a project the way `add` lays it out (with the image-fit it
// requires), its views checked as numbers.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'camera-ken-burns')
rmSync(project, { recursive: true, force: true })
for (const item of ['camera-ken-burns', 'image-fit']) {
  const label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
  }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, item, f), join(project, f))
  }
}
const { moveOf, viewOf } = (await import(
  pathToFileURL(join(project, 'src/motion/ken-burns.ts')).href
)) as typeof import('../camera-ken-burns/src/motion/ken-burns.ts')
type View = import('../camera-ken-burns/src/motion/ken-burns.ts').View

const picture = { width: 4000, height: 3000 }
const A = 16 / 9
const near = (a: number, b: number, what: string) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`)
const isInside = (v: View) =>
  v.x >= -1e-9 &&
  v.y >= -1e-9 &&
  v.x + v.width <= picture.width + 1e-9 &&
  v.y + v.height <= picture.height + 1e-9

test('camera-ken-burns: a box framed at its fill, its centre at the eye line', () => {
  const v = viewOf(picture, { on: [1800, 1200, 300, 400] }, A)
  near(v.height, 800, 'the box is half the height')
  near(v.width / v.height, A, 'the aspect')
  near(1200 + 200 - v.y, 0.42 * v.height, 'the box centre sits 0.42 down')
  near(v.x + v.width / 2, 1950, 'centred across')
  const lower = viewOf(picture, { on: [1800, 1200, 300, 400], eye: 0.6, dy: 0.1 }, A)
  near(1400 - lower.y, (0.6 - 0.1) * lower.height, 'eye and dy move the view')
})

test('camera-ken-burns: a wide box takes at most maxWidth of the frame', () => {
  const v = viewOf(picture, { on: [1000, 1400, 1840, 200] }, A)
  near(v.width, 2000, 'widened to 92%')
  near(viewOf(picture, { on: [1000, 1400, 1600, 200], maxWidth: 0.5 }, A).width, 3200, 'maxWidth')
})

test('camera-ken-burns: full is the largest crop of the aspect, and zooms by fill', () => {
  const v = viewOf(picture, { on: 'full' }, A)
  assert.deepEqual(v, { x: 0, y: 375, width: 4000, height: 2250 })
  near(viewOf(picture, { on: 'full', fill: 2 }, A).width, 2000, 'fill 2 shows half')
  near(viewOf(picture, { on: 'full' }, 9 / 16).height, 3000, 'a tall frame takes the height')
})

test('camera-ken-burns: every view stays inside the picture', () => {
  const framings = [
    { on: [0, 0, 200, 300] as const },
    { on: [3900, 2900, 100, 100] as const, eye: 0.1 },
    { on: [100, 100, 3900, 2900] as const },
    { on: [2000, 1500, 10, 10] as const, fill: 0.01 },
    { on: 'full' as const, fill: 0.5, dx: 0.3 },
    { on: 'full' as const, fill: 3, dx: -2, dy: 2 },
  ]
  for (const a of framings) {
    assert.ok(isInside(viewOf(picture, a, A)), JSON.stringify(a))
    for (const b of framings)
      for (const p of [-0.2, 0, 0.3, 0.5, 0.9, 1, 1.2])
        assert.ok(isInside(moveOf(picture, a, b, p, A)), `${JSON.stringify([a, b])} at ${p}`)
  }
})

test('camera-ken-burns: a move ends on its framings and pushes at an even log speed', () => {
  const from = { on: 'full' } as const
  const to = { on: [1800, 1200, 300, 400], fill: 0.6 } as const
  assert.deepEqual(moveOf(picture, from, to, 0, A), viewOf(picture, from, A))
  const end = moveOf(picture, from, to, 1, A)
  const b = viewOf(picture, to, A)
  for (const k of ['x', 'y', 'width', 'height'] as const) near(end[k], b[k], k)
  const logs = Array.from({ length: 11 }, (_, i) =>
    Math.log(moveOf(picture, from, to, i / 10, A).width),
  )
  for (let i = 1; i < logs.length; i++)
    near((logs[i] ?? 0) - (logs[i - 1] ?? 0), ((logs[10] ?? 0) - (logs[0] ?? 0)) / 10, `step ${i}`)
})
