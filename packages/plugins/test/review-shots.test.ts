// review-shots, with Python: copied into a project the way `add` lays it out, then run on a film
// made here from a seed whose every frame's truth is known (review-shots-truth.ts), and held to the
// pass table of issues #49 and #75. Needs ffmpeg and a Python with scenedetect and OpenCV (PYTHON
// names it, else python3, or python on Windows), and the first time TransNet V2's weights (30 MB,
// downloaded by the tool); without them the tests skip and say so.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { exportFrames } from '@shaderera/core'
import { FPS, FRAMES, H, inspect, render, SHOTS, W } from './review-shots-truth.ts'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'review-shots')
const film = join(plugins, 'out', 'review-shots-truth.mp4')
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const deps = spawnSync(python, ['-c', 'import cv2, numpy, scenedetect'], { encoding: 'utf8' })
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const skip =
  deps.status !== 0
    ? `review-shots needs ${python} with scenedetect and OpenCV (pip install "scenedetect>=0.7" numpy), or PYTHON naming one`
    : ffmpeg
      ? false
      : 'review-shots needs ffmpeg on the PATH to make its test film'

/** The truth film, exported as any Shaderera source is (with its determinism check), once. */
let made: Promise<unknown> | undefined
const make = () => {
  made ??= (async () => {
    mkdirSync(dirname(film), { recursive: true })
    const encode = spawn(
      'ffmpeg',
      [
        ...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`],
        ...['-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16'],
        film,
      ],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    )
    const closed = new Promise<number | null>((r) => encode.on('close', r))
    await exportFrames({
      fps: FPS,
      from: 0,
      to: FRAMES / FPS,
      render: async (t) => render(t),
      inspect: async (t) => inspect(t),
      sink: {
        write: (px) => new Promise<void>((r) => encode.stdin.write(px, () => r())),
        end: async () => {
          encode.stdin.end()
          assert.equal(await closed, 0, 'ffmpeg encodes the truth film')
        },
      },
    })
  })()
  return made
}

const setUp = async () => {
  await make()
  rmSync(project, { recursive: true, force: true })
  const label = JSON.parse(
    readFileSync(join(plugins, 'review-shots', 'shaderera.item.json'), 'utf8'),
  ) as { files: string[] }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, 'review-shots', f), join(project, f))
  }
  mkdirSync(join(project, 'footage'), { recursive: true })
  cpSync(film, join(project, 'footage', 'truth.mp4'))
}
const run = (...args: string[]) =>
  spawnSync(python, ['tools/review-shots.py', ...args], { cwd: project, encoding: 'utf8' })

type Shot = {
  start: number
  end: number
  zoom: number | null
  pan: [number, number] | null
  move: string[] | null
}

test('review-shots: measured against ground truth, it passes the gate', { skip }, async (t) => {
  await setUp()
  const result = run('footage/truth.mp4')
  if (/could not download the TransNet V2 weights/.test(result.stderr)) {
    t.skip(result.stderr.trim())
    return
  }
  assert.equal(result.status, 0, result.stderr)
  const doc = JSON.parse(readFileSync(join(project, 'shots', 'truth', 'shots.json'), 'utf8'))
  assert.equal(doc.format, 'shaderera.analysis/1')
  assert.equal(doc.kind, 'shots')
  const video = join(project, 'footage', 'truth.mp4')
  assert.equal(doc.source.path, 'footage/truth.mp4')
  assert.equal(doc.source.bytes, statSync(video).size)
  assert.equal(doc.source.sha256, createHash('sha256').update(readFileSync(video)).digest('hex'))
  assert.equal(doc.source.frames, FRAMES)
  assert.ok(existsSync(join(project, 'shots', 'truth', 'sheet-1.jpg')))
  const shots = doc.shots as Shot[]

  // Cuts: a hard cut on its frame, a transition's (a flash, a dip, a dissolve) anywhere in it ±1,
  // and only one each. A card swapped over a picture that goes on is not found (#75): one inside it
  // counts, none is not a miss, two fail. No cut in fast footage, a fast pull or a spotlight.
  const cuts = shots.slice(1).map((s) => Math.round(s.start * FPS))
  const windows = SHOTS.slice(1).map(
    (s) =>
      (s.transition ? [s.transition[0] - 1, s.transition[1] + 1] : [s.cut, s.cut]) as [
        number,
        number,
      ],
  )
  const inside = (c: number, [a, b]: [number, number]) => c >= a && c <= b
  const found = windows.map((w) => cuts.filter((c) => inside(c, w)).length)
  const overlay = (i: number) => SHOTS[i + 1]?.overlay
  const recall =
    found.filter((n, i) => n > 0 && !overlay(i)).length / found.filter((_, i) => !overlay(i)).length
  const precision = cuts.filter((c) => windows.some((w) => inside(c, w))).length / cuts.length
  t.diagnostic(`cuts ${cuts.join(' ')}; precision ${precision}, recall ${recall}`)
  assert.ok(precision >= 0.98 && recall >= 0.98, `cuts ${cuts} against ${JSON.stringify(windows)}`)
  assert.deepEqual(
    found.filter((_, i) => SHOTS[i + 1]?.transition && !overlay(i)),
    [1, 1, 1, 1, 1, 1],
    'the flash, the dip and each dissolve are one cut each',
  )
  assert.ok(
    found.every((n) => n <= 1),
    'no transition is two cuts',
  )

  // Moves, on every shot found long enough to measure (a second or more; on a 4-frame shot a
  // rate of 0.2 % a second is a fiftieth of a pixel): each against the truth shot holding its middle.
  let directions = 0
  let moving = 0
  for (const s of shots) {
    const middle = ((s.start + s.end) / 2) * FPS
    const truth = SHOTS.find((x) => x.cut <= middle && middle < x.end)
    assert.ok(truth && s.zoom !== null && s.pan !== null)
    t.diagnostic(
      `${truth.content} zoom ${truth.zoom} pan ${truth.pan}: ${s.zoom} ${s.pan} ${s.move}`,
    )
    // A push on a dark picture while a spotlight closes in under a label still reads too slow (#75).
    if (s.end - s.start < 1 || truth.spot) continue
    assert.ok(Math.abs(s.zoom - truth.zoom) <= 0.2, `zoom ${s.zoom}, made ${truth.zoom}`)
    const [x, y] = truth.pan
    if (Math.hypot(x, y) >= 0.005) {
      moving++
      const [px, py] = s.pan
      if (
        Math.abs(x) > Math.abs(y)
          ? Math.sign(px) === Math.sign(x) && Math.abs(px) > Math.abs(py)
          : Math.sign(py) === Math.sign(y) && Math.abs(py) > Math.abs(px)
      )
        directions++
    }
    if (truth.content === 'subject')
      assert.deepEqual(s.move, ['static'], 'a subject moving is no move')
  }
  assert.ok(moving >= 3 && directions / moving >= 0.95, `${directions} of ${moving} pans right`)
})

test('review-shots: keeps to the project and to one video per folder', { skip }, async () => {
  await setUp()
  cpSync(join(project, 'footage', 'truth.mp4'), join(project, 'footage', 'other.mp4'))
  // A folder holding another video's shots, as a run on truth.mp4 leaves it.
  mkdirSync(join(project, 'shots', 'a'), { recursive: true })
  writeFileSync(
    join(project, 'shots', 'a', 'shots.json'),
    JSON.stringify({ source: { path: 'footage/truth.mp4' } }),
  )
  const clash = run('footage/other.mp4', '--out', 'shots/a')
  assert.notEqual(clash.status, 0)
  assert.match(clash.stderr, /shots\/a holds the shots of footage\/truth\.mp4/)

  const outside = run(join(plugins, 'review-shots', 'README.md'))
  assert.notEqual(outside.status, 0)
  assert.match(outside.stderr, /is outside this project/)
})
