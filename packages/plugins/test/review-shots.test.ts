// review-shots, with Python: copied into a project the way `add` lays it out, then run on a video
// made here with known cuts and known camera moves. Needs a Python with scenedetect and OpenCV
// (PYTHON names it, else python3, or python on Windows); without one the tests skip and say so.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'review-shots')
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const deps = spawnSync(python, ['-c', 'import cv2, numpy, scenedetect'], { encoding: 'utf8' })
const skip =
  deps.status === 0
    ? false
    : `review-shots needs ${python} with scenedetect and OpenCV (pip install "scenedetect>=0.7" numpy), or PYTHON naming one`

/** Five 1 s shots at 30 fps, each its own colour of blurred noise: static, a push to 115%, a pan
 * right at 0.2 frame widths a second, a tilt down at 0.15, and a pull from 115%. */
const MAKE = `
import sys, cv2, numpy as np
W, H, FPS = 480, 270, 30
SHOTS = [(0, 1, 1, 0, 0), (40, 1, 1.15, 0, 0), (80, 1, 1, 0.2, 0), (120, 1, 1, 0, 0.15), (160, 1.15, 1, 0, 0)]
rng = np.random.default_rng(1)
out = cv2.VideoWriter(sys.argv[1], cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H))
for hue, s0, s1, dx, dy in SHOTS:
    noise = cv2.GaussianBlur(rng.random((H * 2, W * 2)).astype(np.float32), (0, 0), 3)
    noise = cv2.normalize(noise, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    texture = cv2.cvtColor(np.dstack([np.full_like(noise, hue), np.full_like(noise, 160), noise]), cv2.COLOR_HSV2BGR)
    for f in range(FPS):
        s, cx, cy = s0 * (s1 / s0) ** (f / (FPS - 1)), W + dx * W * f / FPS, H + dy * W * f / FPS
        out.write(cv2.warpAffine(texture, np.array([[s, 0, W / 2 - s * cx], [0, s, H / 2 - s * cy]]), (W, H)))
out.release()
`

const setUp = () => {
  rmSync(project, { recursive: true, force: true })
  const label = JSON.parse(
    readFileSync(join(plugins, 'review-shots', 'shaderera.item.json'), 'utf8'),
  ) as { files: string[] }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, 'review-shots', f), join(project, f))
  }
  mkdirSync(join(project, 'footage'), { recursive: true })
  const made = spawnSync(python, ['-c', MAKE, 'footage/known.mp4'], {
    cwd: project,
    encoding: 'utf8',
  })
  assert.equal(made.status, 0, made.stderr)
}
const run = (...args: string[]) =>
  spawnSync(python, ['tools/review-shots.py', ...args], { cwd: project, encoding: 'utf8' })

type Shot = { start: number; end: number; move: string[] | null; zoom: number; pan: number[] }

test('review-shots: known cuts and camera moves come back, with the source and a contact sheet', {
  skip,
}, () => {
  setUp()
  const result = run('footage/known.mp4')
  assert.equal(result.status, 0, result.stderr)
  const doc = JSON.parse(readFileSync(join(project, 'shots', 'known', 'shots.json'), 'utf8'))
  assert.equal(doc.format, 'shaderera.analysis/1')
  assert.equal(doc.kind, 'shots')
  const video = join(project, 'footage', 'known.mp4')
  assert.equal(doc.source.path, 'footage/known.mp4')
  assert.equal(doc.source.bytes, statSync(video).size)
  assert.equal(doc.source.sha256, createHash('sha256').update(readFileSync(video)).digest('hex'))
  assert.equal(doc.source.frames, 150)

  const shots = doc.shots as Shot[]
  assert.deepEqual(
    shots.map((s) => s.start),
    [0, 1, 2, 3, 4],
    'a cut on every second, to the frame',
  )
  assert.equal(shots.at(-1)?.end, 5)
  assert.deepEqual(
    shots.map((s) => s.move),
    [['static'], ['push'], ['pan'], ['tilt'], ['pull']],
  )
  // 115% over the shot's 29 frame steps, measured over 27 of them (27/30 s): about +15.4% a
  // second; the pull is the same scale backwards (about −13.6%).
  const [still, push, pan, tilt, pull] = shots as [Shot, Shot, Shot, Shot, Shot]
  const zoom = (to: number) => ((to ** (27 / 29) - 1) * 100) / (27 / 30)
  assert.ok(Math.abs(still.zoom) < 0.3 && Math.hypot(...still.pan) < 0.003, JSON.stringify(still))
  assert.ok(Math.abs(push.zoom - zoom(1.15)) < 0.3, `push ${push.zoom}`)
  assert.ok(Math.abs(pull.zoom - zoom(1 / 1.15)) < 0.3, `pull ${pull.zoom}`)
  assert.ok(Math.abs((pan.pan[0] as number) - 0.2) < 0.005, `pan ${pan.pan}`)
  assert.ok(Math.abs((tilt.pan[1] as number) - 0.15) < 0.005, `tilt ${tilt.pan}`)
  assert.ok(existsSync(join(project, 'shots', 'known', 'sheet-1.jpg')))
})

/** One texture for 30 frames, its hue turned for 3, then a cut to another: the two detectors cut
 * 3 frames apart. */
const NEAR = `
import sys, cv2, numpy as np
rng = np.random.default_rng(2)
out = cv2.VideoWriter(sys.argv[1], cv2.VideoWriter_fourcc(*'mp4v'), 30, (480, 270))
def texture(hue):
    noise = cv2.GaussianBlur(rng.random((270, 480)).astype(np.float32), (0, 0), 3)
    noise = cv2.normalize(noise, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    return np.dstack([np.full_like(noise, hue), np.full_like(noise, 160), noise])
a, b = texture(0), texture(120)
turned = a.copy()
turned[..., 0] = 40
for hsv in [a] * 30 + [turned] * 3 + [b] * 30:
    out.write(cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR))
out.release()
`

test('review-shots: two cuts closer than --min-shot are one', { skip }, () => {
  setUp()
  const made = spawnSync(python, ['-c', NEAR, 'footage/near.mp4'], {
    cwd: project,
    encoding: 'utf8',
  })
  assert.equal(made.status, 0, made.stderr)
  const result = run('footage/near.mp4')
  assert.equal(result.status, 0, result.stderr)
  const doc = JSON.parse(readFileSync(join(project, 'shots', 'near', 'shots.json'), 'utf8'))
  assert.deepEqual(
    (doc.shots as Shot[]).map((s) => s.start),
    [0, 1],
  )
})

test('review-shots: keeps to the project and to one video per folder', { skip }, () => {
  setUp()
  cpSync(join(project, 'footage', 'known.mp4'), join(project, 'footage', 'other.mp4'))
  assert.equal(run('footage/known.mp4', '--out', 'shots/a').status, 0)
  const clash = run('footage/other.mp4', '--out', 'shots/a')
  assert.notEqual(clash.status, 0)
  assert.match(clash.stderr, /shots\/a holds the shots of footage\/known\.mp4/)

  const outside = run(join(plugins, 'review-shots', 'README.md'))
  assert.notEqual(outside.status, 0)
  assert.match(outside.stderr, /is outside this project/)
})
