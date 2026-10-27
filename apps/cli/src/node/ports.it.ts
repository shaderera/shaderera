import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { yuv420pToRgba } from '@shaderera/core/gpu'
import { encode as encodePng } from 'fast-png'
import jpeg from 'jpeg-js'
import { tempDir } from '../fixtures/temp.ts'
import { openBrowserChild } from './browser.ts'
import { buildForNode } from './build.ts'
import { type Child, openChild } from './child.ts'
import { findProject } from './project.ts'
import { stillsDecoded } from './services.ts'

/**
 * io.image, io.video and io.cache, in the Node host and the browser host:
 * the same bytes in both. Needs ffmpeg, Chrome and a GPU; without them this fails, it does not skip.
 */
const root = tempDir('ports')
mkdirSync(join(root, 'src'))
mkdirSync(join(root, 'assets'))
// `webgpu` (Dawn) for the Node host's GPU, as contract.it.ts, and core for videoTexture.
mkdirSync(join(root, 'node_modules', '@shaderera'), { recursive: true })
for (const [from, to] of [
  ['../../fixtures/particles/node_modules/webgpu', 'webgpu'],
  ['../../node_modules/@shaderera/core', '@shaderera/core'],
] as const)
  symlinkSync(
    realpathSync(join(import.meta.dirname, from)),
    join(root, 'node_modules', to),
    'junction',
  )
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
// ADR 0027's fixtures for videoTexture: every matrix, range and siting, odd sizes, the code
// extremes and hard edges, as planes the film converts on the GPU.
const fixtures = [
  [16, 8],
  [7, 5],
].flatMap(([w, h]) =>
  (['bt709', 'bt601', 'bt2020nc'] as const).flatMap((matrix) =>
    (['limited', 'full'] as const).flatMap((range) =>
      (['left', 'center', 'topleft'] as const).map((chroma) => ({
        w: w as number,
        h: h as number,
        colour: { matrix, range, chroma },
        planes: Array.from(
          {
            length:
              (w as number) * (h as number) +
              2 * Math.ceil((w as number) / 2) * Math.ceil((h as number) / 2),
          },
          (_, i) =>
            i % 3
              ? ([0, 16, 128, 235, 240, 255][(i * 7) % 6] as number)
              : (i * 37 + (h as number)) & 255,
        ),
      })),
    ),
  ),
)
writeFileSync(join(root, 'assets', 'fixtures.json'), JSON.stringify(fixtures))
writeFileSync(
  join(root, 'shaderera.json'),
  JSON.stringify({ entry: './src/c.ts', fps: 10, duration: 1, width: 8, height: 8 }),
)
writeFileSync(
  join(root, 'src', 'c.ts'),
  `import { readTexture, videoTexture } from '@shaderera/core/gpu'
const hex = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('')
export default async ({ io, gpu }) => {
  const png = await io.image('assets/deep.png')
  const jpg = await io.image('assets/photo.jpg')
  const small = await io.image('assets/deep.png', { maxSize: 3 })
  const clip = await io.video('assets/clip.mp4')
  const frames = [await clip.frame(3), await clip.frame(4), await clip.frame(1)]
  await clip.close()
  frames.push(await clip.frame(3))
  const yuv = [await clip.frame(3, { format: 'yuv420p' }), await clip.frame(1, { format: 'yuv420p' })]
  const texture = videoTexture(gpu, clip)
  const converted = await readTexture(gpu, await texture.frame(3))
  texture.destroy()
  const fixtures = JSON.parse(new TextDecoder().decode(await io.read('assets/fixtures.json')))
  const references = []
  for (const { w, h, colour, planes } of fixtures) {
    const v = videoTexture(gpu, { width: w, height: h, colour, frame: async () => new Uint8Array(planes) })
    references.push(await hex(await readTexture(gpu, await v.frame(0))))
    v.destroy()
  }
  let made = 0
  const derived = await io.cache('shout v1', ['assets/photo.jpg'], async () => { made++; return new Uint8Array([7, 8, 9]) })
  const canvas = io.canvas(8, 8)
  return {
    render: async () => (canvas.getContext('2d').clearRect(0, 0, 8, 8), { color: canvas }),
    inspect: async () => ({
      png: { bits: png.bits, w: png.width, first: Array.from(png.data.slice(0, 4)), hash: await hex(new Uint8Array(png.data.buffer)) },
      jpg: { w: jpg.width, hash: await hex(jpg.data) },
      small: { w: small.width, h: small.height, bits: small.bits, hash: await hex(new Uint8Array(small.data.buffer)) },
      clip: { w: clip.width, h: clip.height, fps: clip.fps, frames: clip.frames, colour: clip.colour, hashes: await Promise.all(frames.map(hex)) },
      yuv: await Promise.all(yuv.map(hex)),
      converted: await hex(converted),
      references,
      derived: Array.from(derived),
      made,
    }),
  }
}`,
)
const project = await findProject(root)
const entryFile = await buildForNode(project)
const node = () => openChild(project, { entryFile })
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

test('io.image decodes a 16-bit PNG and a JPEG, and shrinks to maxSize; io.video gives frame i as ffmpeg decodes it', async () => {
  const child = await node()
  try {
    const j = (await child.inspect(0)) as {
      png: { bits: number; w: number; first: number[] }
      small: { w: number; h: number; bits: number }
      clip: { w: number; h: number; fps: number; frames: number; hashes: string[] }
      yuv: string[]
      converted: string
      references: string[]
      derived: number[]
    }
    assert.equal(j.png.bits, 16)
    assert.deepEqual(j.png.first, [...deep.slice(0, 4)])
    assert.deepEqual([j.small.w, j.small.h, j.small.bits], [3, 2, 16], 'maxSize 3 on a 6×4 still')
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
    // yuv420p: the file's own planes, and videoTexture's conversion of them the reference's.
    const planes = (n: number) =>
      spawnSync(
        'ffmpeg',
        [
          ...['-v', 'error', '-i', join(root, 'assets', 'clip.mp4')],
          ...['-vf', `select=eq(n\\,${n})`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'],
        ],
        { maxBuffer: 1 << 24 },
      ).stdout
    assert.deepEqual(j.yuv, [sha(planes(3)), sha(planes(1))])
    const colour = { matrix: 'bt601', range: 'limited', chroma: 'left' } as const
    assert.deepEqual((j.clip as { colour?: unknown }).colour, colour, 'an untagged H.264')
    assert.equal(j.converted, sha(yuv420pToRgba(planes(3), 32, 16, colour)))
    assert.deepEqual(
      j.references,
      fixtures.map((x) => sha(yuv420pToRgba(new Uint8Array(x.planes), x.w, x.h, x.colour))),
      'videoTexture is the reference, byte for byte',
    )
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

test('the browser host decodes, reads and converts on the GPU the same bytes as the Node host', async () => {
  const children: Child[] = [await node(), await openBrowserChild(project, {})]
  try {
    const [n, b] = await Promise.all(children.map((c) => c.inspect(0)))
    assert.deepEqual(b, n)
  } finally {
    await Promise.all(children.map((c) => c.close()))
  }
})

test('io.image decodes a still once for every host of a command, and again only when it changed', async () => {
  rmSync(join(root, '.shaderera', 'cache'), { recursive: true, force: true })
  const decoded = () => stillsDecoded.count
  const before = decoded()
  // Three hosts at once: deep.png full and at maxSize 3, and photo.jpg, each decoded once.
  const children: Child[] = await Promise.all([node(), node(), openBrowserChild(project, {})])
  try {
    // Without io.cache's count, which depends on which host made its entry first.
    const [a, b, c] = (await Promise.all(children.map((child) => child.inspect(0)))).map((j) => ({
      ...(j as object),
      made: undefined,
    }))
    assert.deepEqual(b, a)
    assert.deepEqual(c, a)
    assert.equal(decoded() - before, 3)
  } finally {
    await Promise.all(children.map((child) => child.close()))
  }
  // The next command reads them from the cache.
  const next = await node()
  try {
    await next.inspect(0)
    assert.equal(decoded() - before, 3, 'kept in .shaderera/cache')
  } finally {
    await next.close()
  }
  // A changed file is decoded again, at both its sizes.
  const changed = deep.map((v) => 65535 - v)
  writeFileSync(
    join(root, 'assets', 'deep.png'),
    encodePng({ width: W, height: H, data: changed, depth: 16, channels: 4 }),
  )
  const after = await node()
  try {
    const j = (await after.inspect(0)) as { png: { first: number[] } }
    assert.deepEqual(j.png.first, [...changed.slice(0, 4)])
    assert.equal(decoded() - before, 5)
  } finally {
    await after.close()
  }
  // A still larger than an eighth of the cache's limit is decoded in each host, the same bytes:
  // at 838 bytes, deep.png at full size (192 bytes) is, its maxSize 3 (48) and photo.jpg (96) not.
  process.env.SHADERERA_FILM_CACHE_MB = '0.0008'
  rmSync(join(root, '.shaderera', 'cache'), { recursive: true, force: true })
  const small: Child[] = await Promise.all([node(), openBrowserChild(project, {})])
  try {
    const [n, b] = (await Promise.all(small.map((child) => child.inspect(0)))).map((j) => ({
      ...(j as object),
      made: undefined,
    }))
    assert.deepEqual(b, n)
    assert.equal(decoded() - before, 7, 'only the two stills within the rule')
  } finally {
    delete process.env.SHADERERA_FILM_CACHE_MB
    await Promise.all(small.map((child) => child.close()))
  }
})
