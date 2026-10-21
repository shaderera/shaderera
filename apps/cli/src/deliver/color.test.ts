import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ffmpegArgs, ffmpegSink, type Quality } from '../cli/ffmpeg.ts'
import { tempDir } from '../fixtures/temp.ts'
import { chartFrame, decodeFirstFrame, patchErrors, probeColor } from './fixtures/chart.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const dir = tempDir('chart')

const encode = async (args: string[], frames = 10) => {
  const { pixels } = chartFrame()
  const sink = ffmpegSink(args)
  for (let i = 0; i < frames; i++) await sink.write(pixels)
  await sink.end()
}

const TOLERANCE: { [q in Quality]: number } = { master: 3, review: 4 }

for (const quality of ['review', 'master'] as const) {
  test(`the ${quality} mp4 round-trips the colour chart within ${TOLERANCE[quality]} levels and is tagged BT.709`, {
    skip: !ffmpeg && 'no ffmpeg',
  }, async () => {
    const { width, height } = chartFrame()
    const out = join(dir, `${quality}.mp4`)
    await encode(ffmpegArgs({ width, height, fps: 10, from: 0, to: 1, out, quality }))
    assert.deepEqual(probeColor(out), {
      space: 'bt709',
      primaries: 'bt709',
      transfer: 'bt709',
      range: 'tv',
      pixFmt: 'yuv420p',
    })
    const errors = patchErrors(decodeFirstFrame(out), width)
    const worst = Math.max(...errors.map((e) => e.error))
    if (process.env.SHADERERA_CHART)
      console.log(quality, statSync(out).size, JSON.stringify(errors))
    assert.ok(
      worst <= TOLERANCE[quality],
      JSON.stringify(errors.filter((e) => e.error > TOLERANCE[quality])),
    )
  })
}

test('the old untagged path (swscale default BT.601, no tags) misses the chart as a player decodes it', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const { width, height } = chartFrame()
  const out = join(dir, 'legacy.mp4')
  const args = ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba']
  args.push('-s', `${width}x${height}`, '-r', '10', '-i', '-')
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-t', '1', out)
  await encode(args)
  assert.equal(probeColor(out).space, undefined)
  const errors = patchErrors(decodeFirstFrame(out), width)
  if (process.env.SHADERERA_CHART) console.log('legacy', JSON.stringify(errors))
  assert.ok(Math.max(...errors.map((e) => e.error)) > 10)
})
