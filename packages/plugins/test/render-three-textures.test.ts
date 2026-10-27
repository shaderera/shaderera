// render-three-textures, headless: copied into a project the way `add` lays it out, images read
// through the CLI's own io.image decoder, and the textures' pixels checked against what the
// plugin's former pure-JS decoder gave: the file's 8-bit RGBA (a 16-bit PNG's high byte), rows
// flipped so v = 0 is the bottom.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'
import { decode as decodePng, encode as encodePng } from 'fast-png'
import jpeg from 'jpeg-js'
import { decodeImage } from '../../../apps/cli/src/runner/image.ts'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'render-three-textures')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'render-three-textures', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'render-three-textures', f), join(project, f))
}
const { loadAtlas, loadTexture, textureOf } = (await import(
  pathToFileURL(join(project, 'src/three/textures.ts')).href
)) as typeof import('../render-three-textures/src/three/textures.ts')

const read = (p: string) => new Uint8Array(readFileSync(join(project, p)))
const host = {
  io: { read: async (p: string) => read(p), image: async (p: string) => decodeImage(read(p), p) },
} as unknown as Host

const W = 13
const H = 7
const ramp = (n: number, k: number) => Uint8Array.from({ length: n }, (_, i) => (i * k) % 256)
mkdirSync(join(project, 'assets'), { recursive: true })
writeFileSync(
  join(project, 'assets/rgba.png'),
  encodePng({ width: W, height: H, data: ramp(W * H * 4, 37), channels: 4 }),
)
writeFileSync(
  join(project, 'assets/photo.jpg'),
  jpeg.encode({ width: W, height: H, data: ramp(W * H * 4, 53) }, 90).data,
)
writeFileSync(
  join(project, 'assets/deep.png'),
  encodePng({
    width: W,
    height: H,
    data: Uint16Array.from({ length: W * H * 3 }, (_, i) => (i * 4099) % 65536),
    channels: 3,
    depth: 16,
  }),
)

/** What the former decoder gave for each fixture: 8-bit RGBA, rows top-down. */
const former = (path: string) => {
  const bytes = read(path)
  if (path.endsWith('.jpg'))
    return new Uint8Array(jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true }).data)
  const png = decodePng(bytes)
  const out = new Uint8Array(W * H * 4)
  const shift = png.depth === 16 ? 8 : 0
  for (let i = 0; i < W * H; i++)
    for (let c = 0; c < 4; c++)
      out[i * 4 + c] = c < png.channels ? (png.data[i * png.channels + c] as number) >> shift : 255
  return out
}
const flipped = (data: Uint8Array) => {
  const out = new Uint8Array(data.length)
  for (let y = 0; y < H; y++)
    out.set(data.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4)
  return out
}
const pixels = (t: { image: unknown }) => (t.image as { data: Uint8Array }).data

for (const path of ['assets/rgba.png', 'assets/photo.jpg', 'assets/deep.png'])
  test(`render-three-textures: a texture from io.image is pixel-equal to the former decoder's (${path})`, async () => {
    const { texture, aspect, width, height } = await loadTexture(host, path)
    assert.deepEqual([width, height, aspect], [W, H, W / H])
    if (path.endsWith('.jpg')) {
      // io.image smooths a JPEG's chroma where jpeg-js repeated it (ADR 0028, 3): close, not equal.
      const was = flipped(former(path))
      const mean = [...pixels(texture)].reduce((s, v, i) => s + Math.abs(v - (was[i] as number)), 0)
      assert.ok(mean / was.length < 3, `mean difference ${mean / was.length}`)
    } else assert.deepEqual(pixels(texture), flipped(former(path)))
    assert.deepEqual(pixels(textureOf(decodeImage(read(path), path))), pixels(texture))
  })

test('render-three-textures: an atlas cell at full size holds the image as it is', async () => {
  const atlas = await loadAtlas(host, ['assets/rgba.png'], { cell: W })
  // Centred in its square cell, `top` rows down.
  const top = Math.floor((W - H) / 2)
  assert.deepEqual(atlas.rects[0], { rect: [0, 1 - (top + H) / W, 1, H / W], aspect: W / H })
  const data = pixels(atlas.texture)
  const image = flipped(former('assets/rgba.png'))
  const row = W * 4
  for (let y = 0; y < H; y++)
    assert.deepEqual(
      data.subarray((W - top - H + y) * row, (W - top - H + y + 1) * row),
      image.subarray(y * row, (y + 1) * row),
    )
})

test('render-three-textures: a host without io.image is named in the error', async () => {
  const bare = { io: { read: async (p: string) => read(p) } } as unknown as Host
  await assert.rejects(loadTexture(bare, 'assets/rgba.png'), /no io\.image .*rgba\.png/)
})
