// review-av-timeline, headless: copied into a project the way `add` lays it out, then run on a
// film made here whose one white frame is known, and the frame strip around it read back. Needs
// ffmpeg to make the film; without it the test skips and says so.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Canvas, loadImage } from '@napi-rs/canvas'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'review-av-timeline')
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'review-av-timeline', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'review-av-timeline', f), join(project, f))
}

/**
 * Films black but for one white frame, and a moment nearest it. At 24 fps 0.15 s before 3.175 s
 * falls between frames; at 30 fps it snaps to frame 92, 3.06667 s, which four decimals round up
 * past the frame.
 */
const CASES = [
  { fps: 24, white: 76, t: 3.175 },
  { fps: 30, white: 96, t: 3.2 },
]

test('review-av-timeline: the frame labelled with the moment is the frame shown at it', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  for (const { fps: FPS, white: WHITE, t } of CASES) {
    execFileSync(
      'ffmpeg',
      [
        ...[
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          `color=black:size=64x36:rate=${FPS}:duration=5`,
        ],
        ...['-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n\\,${WHITE})'`],
        ...['-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', `film-${FPS}.mp4`],
      ],
      { cwd: project },
    )
    const r = spawnSync(
      process.execPath,
      ['tools/av-review.ts', `film-${FPS}.mp4`, ...['--at', String(t), '--out', `av-${FPS}`]],
      {
        cwd: project,
        encoding: 'utf8',
      },
    )
    assert.equal(r.status, 0, r.stderr)
    const sheet = await loadImage(
      readFileSync(join(project, `av-${FPS}`, `at-${t.toFixed(3)}.png`)),
    )
    const canvas = new Canvas(sheet.width, sheet.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(sheet, 0, 0)
    // The tiles as the tool lays them out: 200 wide, 112 high, a label row of 18 above each.
    const tw = 200
    const th = 112
    const cols = Math.floor(sheet.width / (tw + 4))
    const tiles = Math.floor((sheet.height - 80) / (th + 22)) * cols
    const at = (i: number) => ({ x: (i % cols) * (tw + 4), y: Math.floor(i / cols) * (th + 22) })
    const white: number[] = []
    const red: number[] = []
    for (let i = 0; i < tiles; i++) {
      const { x, y } = at(i)
      const middle = ctx.getImageData(x + tw / 2, y + 18 + th / 2, 1, 1).data
      if ((middle[0] ?? 0) > 200) white.push(i)
      const text = ctx.getImageData(x, y, tw, 18).data
      for (let p = 0; p < text.length; p += 4)
        if ((text[p] ?? 0) > 200 && (text[p + 1] ?? 255) < 150 && (text[p + 2] ?? 255) < 150) {
          red.push(i)
          break
        }
    }
    assert.equal(white.length, 1, `${FPS} fps: white tiles ${white}`)
    assert.deepEqual(red, white, `${FPS} fps: the red label sits over the white frame`)
  }
})
