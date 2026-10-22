import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import {
  canEncode,
  encodersFile,
  ffmpegArgs,
  hardwareEncoder,
  hasEditList,
  measureLoudness,
  probe,
} from './ffmpeg.ts'
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

test("A GPU encoder's answer is kept in ~/.shaderera for this ffmpeg, believed after, and asked again fresh", {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = process.env.USERPROFILE = tempDir('home')
  try {
    // Every GPU encoder is asked, and the first that works is the review's.
    const found = await hardwareEncoder(1920, 1080)
    const kept = JSON.parse(readFileSync(encodersFile(), 'utf8'))
    assert.match(kept.ffmpeg, /ffmpeg version/)
    assert.deepEqual(Object.keys(kept.answers).sort(), [
      'amf 1920x1080',
      'nvenc 1920x1080',
      'qsv 1920x1080',
      'videotoolbox 1920x1080',
    ])
    assert.equal(
      found,
      ['nvenc', 'qsv', 'amf', 'videotoolbox'].find((e) => kept.answers[`${e} 1920x1080`]),
    )
    // NVENC refuses a 32×16 frame: a kept true is believed without a test encode...
    const yes = { 'nvenc 32x16': true }
    writeFileSync(encodersFile(), JSON.stringify({ ...kept, answers: yes }))
    assert.equal(await canEncode('nvenc', 32, 16), true)
    // ...and a fresh ask (doctor) encodes again, keeping the answer it had.
    assert.equal(await canEncode('nvenc', 32, 16, { fresh: true }), false)
    const after = JSON.parse(readFileSync(encodersFile(), 'utf8')).answers
    assert.deepEqual(after, { 'nvenc 32x16': false })
    // Another ffmpeg's answers are not this one's.
    const other = { ffmpeg: 'another', answers: { 'nvenc 30x16': true } }
    writeFileSync(encodersFile(), JSON.stringify(other))
    assert.equal(await canEncode('nvenc', 30, 16), false)
    // The nvenc.json of #219's builds (never released) is ignored, left as it is.
    const old = join(dirname(encodersFile()), 'nvenc.json')
    const key = JSON.parse(readFileSync(encodersFile(), 'utf8')).ffmpeg
    writeFileSync(old, JSON.stringify({ ffmpeg: key, sizes: { '28x16': true } }))
    assert.equal(await canEncode('nvenc', 28, 16), false)
    assert.ok(existsSync(old))
  } finally {
    Object.assign(process.env, home)
  }
})
