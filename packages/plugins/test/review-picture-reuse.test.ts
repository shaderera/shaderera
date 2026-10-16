// review-picture-reuse, with Python: copied into a project with review-shots, which it requires,
// the way `add` lays them out, then run on a video made here where pictures come back cropped.
// Needs a Python with scenedetect and OpenCV (PYTHON names it, else python3, or python on
// Windows); without one the tests skip and say so.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'review-picture-reuse')
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const deps = spawnSync(python, ['-c', 'import cv2, numpy, scenedetect'], { encoding: 'utf8' })
const skip =
  deps.status === 0
    ? false
    : `review-picture-reuse needs ${python} with scenedetect and OpenCV (pip install "scenedetect>=0.7" numpy), or PYTHON naming one`

/** Six 1 s shots at 30 fps of three pictures (shapes on a ground, one hue each) and black:
 * A, B, A cropped and zoomed to 160%, black, C, C cropped to 140%. */
const MAKE = `
import sys, cv2, numpy as np
W, H, FPS = 480, 270, 30
rng = np.random.default_rng(1)
def picture(hue):
    img = np.full((H, W, 3), (hue, 120, 60), np.uint8)
    for _ in range(90):
        x, y = (int(v) for v in rng.integers(0, (W, H)))
        c = (hue, int(rng.integers(80, 255)), int(rng.integers(60, 255)))
        if rng.random() < 0.5:
            cv2.rectangle(img, (x, y), (x + int(rng.integers(8, 60)), y + int(rng.integers(8, 60))), c, -1)
        else:
            cv2.circle(img, (x, y), int(rng.integers(4, 30)), c, -1)
    return cv2.cvtColor(img, cv2.COLOR_HSV2BGR)
def crop(p, s, x, y):
    return cv2.warpAffine(p, np.float32([[s, 0, -s * x], [0, s, -s * y]]), (W, H))
a, b, c = picture(0), picture(60), picture(120)
out = cv2.VideoWriter(sys.argv[1], cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H))
for frame in [a, b, crop(a, 1.6, 120, 60), np.zeros_like(a), c, crop(c, 1.4, 40, 70)]:
    for _ in range(FPS):
        out.write(frame)
out.release()
`

const setUp = () => {
  rmSync(project, { recursive: true, force: true })
  for (const name of ['review-shots', 'review-picture-reuse']) {
    const label = JSON.parse(readFileSync(join(plugins, name, 'shaderera.item.json'), 'utf8')) as {
      files: string[]
    }
    for (const f of label.files) {
      mkdirSync(dirname(join(project, f)), { recursive: true })
      cpSync(join(plugins, name, f), join(project, f))
    }
  }
  mkdirSync(join(project, 'footage'), { recursive: true })
  const made = spawnSync(python, ['-c', MAKE, 'footage/back.mp4'], {
    cwd: project,
    encoding: 'utf8',
  })
  assert.equal(made.status, 0, made.stderr)
  const shots = spawnSync(python, ['tools/review-shots.py', 'footage/back.mp4'], {
    cwd: project,
    encoding: 'utf8',
  })
  assert.equal(shots.status, 0, shots.stderr)
}
const run = (...args: string[]) =>
  spawnSync(python, ['tools/review-picture-reuse.py', ...args], { cwd: project, encoding: 'utf8' })

test('review-picture-reuse: a picture that comes back cropped is one picture', { skip }, () => {
  setUp()
  const result = run('shots/back/shots.json')
  assert.equal(result.status, 0, result.stderr)
  const doc = JSON.parse(readFileSync(join(project, 'shots', 'back', 'picture-reuse.json'), 'utf8'))
  const shots = JSON.parse(readFileSync(join(project, 'shots', 'back', 'shots.json'), 'utf8'))
  assert.equal(doc.format, 'shaderera.analysis/1')
  assert.equal(doc.kind, 'picture-reuse')
  assert.deepEqual(doc.source, {
    path: 'footage/back.mp4',
    bytes: shots.source.bytes,
    sha256: shots.source.sha256,
    shots: 'shots/back/shots.json',
  })
  assert.deepEqual(
    (doc.groups as { id: string; shots: { id: string }[] }[]).map((g) => [
      g.id,
      g.shots.map((s) => s.id),
    ]),
    [
      ['picture-1', ['shot-1', 'shot-3']],
      ['picture-2', ['shot-5', 'shot-6']],
    ],
  )
  // Black has no picture; A comes back after B (a return, 1 s after it was last shown), and C is
  // cut into (an adjacent repeat).
  assert.deepEqual(
    {
      shots: doc.summary.shots,
      seen: doc.summary.shotsWithPicture,
      pictures: doc.summary.pictures,
      returns: doc.summary.returns,
      adjacent: doc.summary.adjacentRepeats,
      gap: doc.summary.returnGapMedian,
    },
    { shots: 6, seen: 5, pictures: 3, returns: 1, adjacent: 1, gap: 1 },
  )
})

test('review-picture-reuse: refuses shots measured from other bytes, or that are not shots', {
  skip,
}, () => {
  setUp()
  cpSync(join(project, 'tools', 'review-shots.py'), join(project, 'footage', 'back.mp4'))
  const stale = run('shots/back/shots.json')
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /was measured from other bytes than footage\/back\.mp4/)

  writeFileSync(join(project, 'other.json'), JSON.stringify({ format: 'shaderera.analysis/1' }))
  const other = run('other.json')
  assert.notEqual(other.status, 0)
  assert.match(other.stderr, /other\.json is not review-shots' shots\.json/)
})
