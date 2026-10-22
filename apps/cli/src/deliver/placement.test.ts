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

test('an HDR placement checks the transfer, the bit depth and the HDR10 metadata', () => {
  const hdr = {
    transfer: ['smpte2084', 'arib-std-b67'],
    bitDepth: [10, 12],
    hdrMetadata: 'required' as const,
  }
  const sdr: Probe = {
    ...probe,
    video: {
      codec: 'h264',
      pixFmt: 'yuv420p',
      width: 1080,
      height: 1920,
      fps: 30,
      color: { transfer: 'bt709' },
    },
  }
  assert.deepEqual(checkPlacement(hdr, 'a.mp4', sdr, null).failures, [
    'transfer bt709, not smpte2084 or arib-std-b67 (--hdr10)',
    '8-bit video, not 10 or 12 (--hdr10)',
    'no HDR10 metadata: mastering display (mdcv), MaxCLL/MaxFALL (clli) (--hdr10)',
  ])
  const display = {
    red: [0.68, 0.32],
    green: [0.265, 0.69],
    blue: [0.15, 0.06],
    white: [0.3127, 0.329],
    peak: 1000,
    min: 0.0001,
  } as const
  const light = { maxCLL: 800, maxFALL: 200 }
  const video = {
    codec: 'hevc',
    profile: 'Main 10',
    pixFmt: 'yuv420p10le',
    width: 1080,
    height: 1920,
    fps: 30,
    color: { matrix: 'bt2020nc', primaries: 'bt2020', transfer: 'smpte2084', range: 'tv' },
  }
  const hevc: Probe = {
    ...probe,
    video: {
      ...video,
      hdr10: { codecTag: 'hvc1', mastering: display, light, sei: { mastering: display, light } },
    },
  }
  const ok = checkPlacement(hdr, 'a.mp4', hevc, null)
  assert.deepEqual(ok.failures, [])
  assert.match(ok.measured, /edit list, 10-bit smpte2084, MaxCLL 800 \/ MaxFALL 200 cd\/m²$/)
  // VideoToolbox's file: the boxes, no SEI.
  const boxes: Probe = {
    ...probe,
    video: { ...video, hdr10: { codecTag: 'hvc1', mastering: display, light, sei: {} } },
  }
  assert.deepEqual(checkPlacement(hdr, 'a.mp4', boxes, null).failures, [
    'no HDR10 metadata: the stream’s SEI',
  ])
  // ProRes 4444 decodes at 12 bits and has no SEI.
  const prores: Probe = {
    ...probe,
    video: {
      ...video,
      codec: 'prores',
      pixFmt: 'yuv444p12le',
      hdr10: { codecTag: 'ap4h', mastering: display, light },
    },
  }
  assert.deepEqual(checkPlacement(hdr, 'a.mov', prores, null).failures, [])
  assert.deepEqual(checkPlacement({ bitDepth: [10] }, 'a.mov', prores, null).failures, [
    '12-bit video, not 10',
  ])
})
