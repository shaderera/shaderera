import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Probe } from '../cli/ffmpeg.ts'
import { checkPlacement } from './placement.ts'

const probe: Probe = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  bytes: 9_000_000,
  duration: 15,
  bitrate: 4_800_000,
  video: { codec: 'h264', pixFmt: 'yuv420p', width: 1080, height: 1920, fps: 30 },
  audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
  editList: true,
}

test('only declared rules are checked, and each broken one says what to change', () => {
  assert.deepEqual(checkPlacement({}, 'a.mp4', probe, null).failures, [])
  const ctv = checkPlacement(
    {
      aspect: '16:9',
      minBitrate: 15_000_000,
      loudness: { integrated: -24, tolerance: 2, maxTruePeak: -2 },
      editList: false,
      durations: [15, 30],
    },
    'a.mp4',
    probe,
    { integrated: -14.2, truePeak: -0.5, range: 6 },
  ).failures
  assert.deepEqual(ctv, [
    'aspect 1080:1920, not 16:9',
    '4.80 Mb/s, below 15.00 Mb/s (--bitrate)',
    '-14.2 LUFS, not -24 ±2 (--loudness=-24)',
    'true peak -0.5 dBTP, above -2',
    'an edit list (--no-edit-list)',
  ])
  const reels = checkPlacement(
    {
      containers: ['mp4', 'mov'],
      aspect: '9:16',
      maxDuration: 900,
      maxBytes: 4e9,
      sampleRates: [48000],
    },
    'a.mp4',
    probe,
    null,
  )
  assert.deepEqual(reels.failures, [])
  assert.match(
    reels.measured,
    /^mp4, h264 1080×1920 30 fps, 15 s, 9\.00 MB, 4\.80 Mb\/s, aac 48000 Hz 2 ch, edit list$/,
  )
  assert.deepEqual(checkPlacement({ audio: 'none' }, 'a.mov', probe, null).failures, [
    'an audio stream on a silent placement (--no-audio)',
  ])
})
