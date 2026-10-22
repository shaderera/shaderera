// audio-beat-clock's analyze-music and review-av-timeline's av-review on long input: copied into a
// project the way `add` lays them out and run with a small stack, so a minute does what a long song
// or film does with the default one (spreading 125,000 values into Math.max overflows it). Needs
// ffmpeg to make the song and the film; without it the tests skip and say so.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'long-input')
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const skip = !ffmpeg && 'no ffmpeg'
rmSync(project, { recursive: true, force: true })
for (const item of ['audio-beat-clock', 'review-av-timeline']) {
  const label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
  }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, item, f), join(project, f))
  }
}
/** Runs a tool with a stack small enough that a minute of input overflows a spread. */
const run = (tool: string, args: string[]) =>
  spawnSync(process.execPath, ['--stack-size=100', tool, ...args], {
    cwd: project,
    encoding: 'utf8',
  })

test('audio-beat-clock: analyze-music measures a song whatever its length', { skip }, () => {
  execFileSync(
    'ffmpeg',
    [...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=60', '-ar', '8000'], 'song.flac'],
    { cwd: project },
  )
  const r = run('tools/analyze-music.ts', ['song.flac', 'song.json'])
  assert.equal(r.status, 0, r.stderr)
  const analysis = JSON.parse(readFileSync(join(project, 'song.json'), 'utf8'))
  assert.ok(analysis.source.seconds > 59)
})

test('review-av-timeline: av-review reviews a film whatever its length', { skip }, () => {
  execFileSync(
    'ffmpeg',
    [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=240:duration=60'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', 'film.mp4'],
    ],
    { cwd: project },
  )
  const r = run('tools/av-review.ts', ['film.mp4', '--out', 'av'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(project, 'av', 'timeline.png')))
})
