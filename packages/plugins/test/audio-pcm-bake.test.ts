// audio-pcm-bake, headless: copied into a project the way `add` lays it out, a quiet tone made by
// a module that reads its pitch from a listed input, baked by the plugin's own tool, and read back
// through a fake host; then the seed, the duration, the input, the module and the file are changed
// one at a time and each is refused.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'audio-pcm-bake')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'audio-pcm-bake', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'audio-pcm-bake', f), join(project, f))
}
const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { loadBaked } = (await from(
  'src/audio/baked.ts',
)) as typeof import('../audio-pcm-bake/src/audio/baked.ts')
const { interleave, stampOf } = (await from(
  'tools/pcm-bake.ts',
)) as typeof import('../audio-pcm-bake/tools/pcm-bake.ts')
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const RATE = 48000
const SEED = 3
const DURATION = 1.5
/** −30.5 dBFS: a test tone stays quiet. */
const LEVEL = 0.03

/** A stereo tone at the pitch data/tone.json names, its phase from the seed; and one that breaks. */
const MODULE = `import { readFileSync } from 'node:fs'
export const tone = (duration, seed) => {
  const { hz } = JSON.parse(readFileSync('data/tone.json', 'utf8'))
  const n = Math.round(duration * ${RATE})
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = ${LEVEL} * Math.sin(2 * Math.PI * hz * i / ${RATE} + seed)
    r[i] = l[i] * 0.5
  }
  return { sampleRate: ${RATE}, channels: [l, r] }
}
export const broken = (duration) => {
  const c = new Float32Array(Math.round(duration * ${RATE}))
  c[24000] = NaN
  return { sampleRate: ${RATE}, channels: [c] }
}
`

const bake = (...args: string[]) =>
  spawnSync(process.execPath, [join(project, 'tools', 'pcm-bake.ts'), ...args], {
    cwd: project,
    encoding: 'utf8',
  })
const hostOf = (files: Map<string, Uint8Array>, o: { seed?: number; duration?: number } = {}) =>
  ({
    seed: o.seed ?? SEED,
    manifest: { duration: o.duration ?? DURATION },
    io: {
      read: async (p: string) => files.get(p) ?? new Uint8Array(readFileSync(join(project, p))),
    },
  }) as unknown as Host

test('audio-pcm-bake: samples are interleaved as they are, and NaN, Inf or ragged channels are refused', () => {
  const l = Float32Array.from([0.1, -0.2, 0.3])
  const r = Float32Array.from([-0.4, 0.5, -0.6])
  const { data, frames, peak } = interleave({ sampleRate: RATE, channels: [l, r] })
  assert.deepEqual([...data], [...Float32Array.from([0.1, -0.4, -0.2, 0.5, 0.3, -0.6])])
  assert.equal(frames, 3)
  assert.equal(peak, Math.fround(0.6))
  const bad = Float32Array.from([0, Number.POSITIVE_INFINITY])
  assert.throws(
    () => interleave({ sampleRate: RATE, channels: [bad] }),
    /channel 0, sample 1 .* is Infinity/,
  )
  assert.throws(() => interleave({ sampleRate: RATE, channels: [l, bad] }), /differ in length/)
  assert.throws(() => interleave({ sampleRate: RATE, channels: [l, l, l] }), /3 channels/)
  assert.throws(() => interleave({ sampleRate: 44100.5, channels: [l] }), /whole number/)
  assert.equal(stampOf('assets/music/bed.m4a'), 'assets/music/bed.stamp.json')
})

test('audio-pcm-bake: the tool bakes a module, and open refuses a changed seed, duration, input, module or file', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  writeFileSync(
    join(project, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 30,
      duration: DURATION,
      width: 64,
      height: 64,
      seed: SEED,
    }),
  )
  mkdirSync(join(project, 'src', 'music'), { recursive: true })
  mkdirSync(join(project, 'data'), { recursive: true })
  writeFileSync(join(project, 'src', 'music', 'tone.ts'), MODULE)
  writeFileSync(join(project, 'data', 'tone.json'), JSON.stringify({ hz: 220 }))

  const nan = bake('src/music/tone.ts', '--out', 'assets/music/broken.m4a', '--export', 'broken')
  assert.equal(nan.status, 2)
  assert.match(nan.stderr, /channel 0, sample 24000 \(0\.500 s\) is NaN; nothing written/)
  assert.ok(!existsSync(join(project, 'assets', 'music', 'broken.m4a')))

  const run = bake(
    'src/music/tone.ts',
    ...['--out', 'assets/music/tone.m4a', '--export', 'tone', '--inputs', 'data/tone.json'],
  )
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /peak 0\.0300 \(-30\.5 dBFS\); synthesis \d+\.\d s/)
  const stamp = JSON.parse(
    readFileSync(join(project, 'assets', 'music', 'tone.stamp.json'), 'utf8'),
  )
  assert.equal(stamp.kind, 'pcm-bake')
  assert.equal(stamp.source.path, 'src/music/tone.ts')
  assert.deepEqual(
    stamp.inputs.map((f: { path: string }) => f.path),
    ['data/tone.json'],
  )
  assert.deepEqual(
    { seed: stamp.params.seed, duration: stamp.params.duration, channels: stamp.output.channels },
    { seed: SEED, duration: DURATION, channels: 2 },
  )
  assert.equal(
    stamp.command,
    'node tools/pcm-bake.ts src/music/tone.ts --out assets/music/tone.m4a --export tone --inputs data/tone.json',
  )
  // The file holds the tone: its length, and the left channel's level in the middle, as made.
  const raw = execFileSync('ffmpeg', [
    ...['-v', 'error', '-i', join(project, 'assets', 'music', 'tone.m4a')],
    ...['-f', 'f32le', '-ac', '2', 'pipe:1'],
  ])
  const lr = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  assert.ok(Math.abs(lr.length / 2 / RATE - DURATION) < 0.05, `${lr.length / 2 / RATE} s`)
  const left = lr.filter((_, i) => i % 2 === 0).slice(RATE / 4, RATE)
  const rms = Math.sqrt(left.reduce((s, v) => s + v * v, 0) / left.length)
  assert.ok(Math.abs(rms - LEVEL / Math.SQRT2) < 0.001, `rms ${rms}`)

  const files = new Map<string, Uint8Array>()
  const path = 'assets/music/tone.m4a'
  assert.equal(await loadBaked(hostOf(files), path), path)
  const again = /run node tools\/pcm-bake\.ts src\/music\/tone\.ts .* again/
  await assert.rejects(
    loadBaked(hostOf(files, { seed: SEED + 1 }), path),
    /baked with seed 3, the film's is 4/,
  )
  await assert.rejects(loadBaked(hostOf(files, { seed: SEED + 1 }), path), again)
  await assert.rejects(
    loadBaked(hostOf(files, { duration: 2 }), path),
    /baked for 1\.5 s, the film lasts 2 s/,
  )
  files.set('data/tone.json', new TextEncoder().encode(JSON.stringify({ hz: 330 })))
  await assert.rejects(loadBaked(hostOf(files), path), /other bytes than data\/tone\.json/)
  files.clear()
  files.set('src/music/tone.ts', new TextEncoder().encode(`${MODULE}\n`))
  await assert.rejects(loadBaked(hostOf(files), path), /other bytes than src\/music\/tone\.ts/)
  files.clear()
  files.set(path, new Uint8Array([...readFileSync(join(project, path)), 0]))
  await assert.rejects(loadBaked(hostOf(files), path), /is not the file baked/)
  await assert.rejects(loadBaked(hostOf(files), 'assets/music/none.m4a'), /has no stamp/)

  // Run again after the change, and the new file passes.
  writeFileSync(join(project, 'data', 'tone.json'), JSON.stringify({ hz: 330 }))
  files.clear()
  await assert.rejects(loadBaked(hostOf(files), path), /other bytes than data\/tone\.json/)
  assert.equal(bake(...stamp.command.split(' ').slice(2)).status, 0)
  assert.equal(await loadBaked(hostOf(files), path), path)
})
