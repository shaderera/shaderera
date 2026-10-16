import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encode as encodePng } from 'fast-png'
import jpeg from 'jpeg-js'
import { floatWav, mixLoudness } from '../cli/ffmpeg.ts'
import { exportVideo } from '../cli/render.ts'
import { openBrowserChild } from './browser.ts'
import { buildForNode } from './build.ts'
import { type Child, openChild } from './child.ts'
import { findProject } from './project.ts'

/**
 * io.image, io.video, io.cache and sound made in code, in the Node host and the browser host:
 * the same bytes in both. Needs ffmpeg and Chrome; without them this fails, it does not skip.
 */
const root = mkdtempSync(join(tmpdir(), 'shaderera-ports-'))
mkdirSync(join(root, 'src'))
mkdirSync(join(root, 'assets'))
// A 16-bit PNG with alpha, and a JPEG.
const W = 6
const H = 4
const deep = new Uint16Array(W * H * 4)
for (let i = 0; i < deep.length; i++) deep[i] = (i * 2749) % 65536
writeFileSync(
  join(root, 'assets', 'deep.png'),
  encodePng({ width: W, height: H, data: deep, depth: 16, channels: 4 }),
)
const rgb = new Uint8Array(W * H * 4)
for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) % 256
writeFileSync(
  join(root, 'assets', 'photo.jpg'),
  jpeg.encode({ width: W, height: H, data: rgb }, 90).data,
)
spawnSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=32x16:r=10:d=1',
  '-pix_fmt',
  'yuv420p',
  join(root, 'assets', 'clip.mp4'),
])
writeFileSync(
  join(root, 'shaderera.json'),
  JSON.stringify({ entry: './src/c.ts', fps: 10, duration: 1, width: 8, height: 8 }),
)
writeFileSync(
  join(root, 'src', 'c.ts'),
  `const hex = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('')
export default async ({ io }) => {
  const png = await io.image('assets/deep.png')
  const jpg = await io.image('assets/photo.jpg')
  const clip = await io.video('assets/clip.mp4')
  const frames = [await clip.frame(3), await clip.frame(4), await clip.frame(1)]
  await clip.close()
  frames.push(await clip.frame(3))
  let made = 0
  const derived = await io.cache('shout v1', ['assets/photo.jpg'], async () => { made++; return new Uint8Array([7, 8, 9]) })
  const tone = new Float32Array(48000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000))
  const canvas = io.canvas(8, 8)
  return {
    render: async () => (canvas.getContext('2d').clearRect(0, 0, 8, 8), { color: canvas }),
    inspect: async () => ({
      png: { bits: png.bits, w: png.width, first: Array.from(png.data.slice(0, 4)), hash: await hex(new Uint8Array(png.data.buffer)) },
      jpg: { w: jpg.width, hash: await hex(jpg.data) },
      clip: { w: clip.width, h: clip.height, fps: clip.fps, frames: clip.frames, hashes: await Promise.all(frames.map(hex)) },
      derived: Array.from(derived),
      made,
    }),
    audio: async () => [{ pcm: { sampleRate: 48000, channels: [tone] }, at: 0.25 }],
  }
}`,
)
const wav = join(root, 'assets', 'tone.wav')
writeFileSync(
  wav,
  floatWav({
    sampleRate: 48000,
    channels: [
      new Float32Array(48000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000)),
    ],
  }),
)
const project = await findProject(root)
const entryFile = await buildForNode(project)
const node = () => openChild(project, { entryFile })
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

test('io.image decodes a 16-bit PNG and a JPEG; io.video gives frame i as ffmpeg decodes it', async () => {
  const child = await node()
  try {
    const j = (await child.inspect(0)) as {
      png: { bits: number; w: number; first: number[] }
      clip: { w: number; h: number; fps: number; frames: number; hashes: string[] }
      derived: number[]
    }
    assert.equal(j.png.bits, 16)
    assert.deepEqual(j.png.first, [...deep.slice(0, 4)])
    assert.deepEqual([j.clip.w, j.clip.h, j.clip.fps, j.clip.frames], [32, 16, 10, 10])
    // Frames 3 and then 1 (a jump back) straight from ffmpeg, the same conversion.
    const direct = (n: number) =>
      spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          join(root, 'assets', 'clip.mp4'),
          '-vf',
          `select=eq(n\\,${n}),scale=in_color_matrix=auto:in_range=auto:out_range=full,format=rgba`,
          '-fps_mode',
          'passthrough',
          '-f',
          'rawvideo',
          '-',
        ],
        { maxBuffer: 1 << 24 },
      ).stdout
    assert.equal(j.clip.hashes[0], sha(direct(3)), 'frame 3')
    assert.equal(j.clip.hashes[2], sha(direct(1)), 'frame 1, after a jump back')
    assert.notEqual(j.clip.hashes[0], j.clip.hashes[2])
    assert.equal(j.clip.hashes[3], j.clip.hashes[0], 'frame 3 again, after close')
    assert.deepEqual(j.derived, [7, 8, 9])
  } finally {
    await child.close()
  }
})

test('io.cache makes once and keeps it for the next host; a changed input makes again', async () => {
  const again = await node()
  try {
    assert.equal(((await again.inspect(0)) as { made: number }).made, 0, 'kept from the first')
  } finally {
    await again.close()
  }
  assert.ok(readdirSync(join(root, '.shaderera', 'cache')).length >= 1)
  writeFileSync(
    join(root, 'assets', 'photo.jpg'),
    jpeg.encode({ width: W, height: H, data: rgb.map((v) => 255 - v) }, 90).data,
  )
  const changed = await node()
  try {
    assert.equal(((await changed.inspect(0)) as { made: number }).made, 1)
  } finally {
    await changed.close()
  }
})

test('the browser host decodes and reads the same bytes as the Node host', async () => {
  const children: Child[] = [await node(), await openBrowserChild(project, {})]
  try {
    const [n, b] = await Promise.all(children.map((c) => c.inspect(0)))
    assert.deepEqual(b, n)
  } finally {
    await Promise.all(children.map((c) => c.close()))
  }
})

test('sound made in code is mixed like a file, in both hosts', async () => {
  for (const open of [node, () => openBrowserChild(project, {})]) {
    const child = await open()
    try {
      const done = await exportVideo(project, child, {
        out: join(root, 'out', 'pcm.mp4'),
        revision: 'test',
      })
      assert.equal(done.probe.audio?.sampleRate, 48000)
      // The same tone as a mono WAV file, mixed the same way, measures the same.
      const file = mixLoudness([{ src: 'tone', file: wav, at: 0.25 }], 0, 1)
      assert.ok(done.loudness && file, 'measured')
      assert.ok(
        Math.abs(done.loudness.truePeak - file.truePeak) < 0.2,
        `${done.loudness.truePeak} vs ${file.truePeak}`,
      )
      assert.ok(Math.abs(done.loudness.integrated - file.integrated) < 0.2)
    } finally {
      await child.close()
    }
  }
})
