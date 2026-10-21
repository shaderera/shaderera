import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { ffmpegArgs, hasEditList, hasNvenc, measureLoudness, nvencFile, probe } from './ffmpeg.ts'
import { openMix } from './mix.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const base = { width: 64, height: 36, fps: 10, from: 0, to: 4, out: 'o.mp4' }

test('an mp4 written with an edit list is told from one without; its sound is 48 kHz AAC', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-editlist-'))
  // A 44.1 kHz tone: the mp4 resamples it.
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', join(dir, 'a.wav')])
  const mix = openMix(dir, [{ src: 'a.wav', at: 0 }], { from: 0, to: 1 })
  try {
    for (const editList of [true, false]) {
      const out = join(dir, `${editList}.mp4`)
      const audio = mix.encode(!editList)
      const args = ffmpegArgs({ ...base, to: 1, out, audio, editList, input: 'rgba' })
      assert.ok(args.join(' ').includes('-c:a aac -b:a 192k -ar 48000 -ac 2'))
      spawnSync('ffmpeg', args, { input: new Uint8Array(64 * 36 * 4 * 10) })
      assert.equal(hasEditList(out), editList)
      assert.equal(probe(out).audio?.sampleRate, 48000)
    }
  } finally {
    mix.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the loudness of a film over ten minutes is measured', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-long-'))
  try {
    // 13 minutes of a tone, kept small: 8 kHz, 8 bits, mono.
    const file = join(dir, 'long.wav')
    const args = ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=780:sample_rate=8000']
    spawnSync('ffmpeg', [...args, '-c:a', 'pcm_u8', file])
    const loudness = measureLoudness(file)
    assert.ok(loudness && loudness.integrated > -70, JSON.stringify(loudness))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("NVENC's answer is kept in ~/.shaderera for this ffmpeg, believed after, and asked again fresh", {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = process.env.USERPROFILE = tempDir('home')
  try {
    const has = await hasNvenc(1920, 1080)
    const kept = JSON.parse(readFileSync(nvencFile(), 'utf8'))
    assert.match(kept.ffmpeg, /ffmpeg version/)
    assert.deepEqual(kept.sizes, { '1920x1080': has })
    // NVENC refuses a 32×16 frame: a kept true is believed without a test encode...
    writeFileSync(nvencFile(), JSON.stringify({ ...kept, sizes: { '32x16': true } }))
    assert.equal(await hasNvenc(32, 16), true)
    // ...and a fresh ask (doctor) encodes again, keeping the size it had.
    assert.equal(await hasNvenc(32, 16, { fresh: true }), false)
    assert.deepEqual(JSON.parse(readFileSync(nvencFile(), 'utf8')).sizes, { '32x16': false })
    // Another ffmpeg's answers are not this one's.
    writeFileSync(nvencFile(), JSON.stringify({ ffmpeg: 'another', sizes: { '30x16': true } }))
    assert.equal(await hasNvenc(30, 16), false)
  } finally {
    Object.assign(process.env, home)
  }
})
