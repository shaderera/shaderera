// image-regions, headless: copied into a project the way `add` lays it out, an artifact made from
// painted masks by the plugin's own analyser, and read back through a fake host.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Host } from '@shaderera/core'
import { encode } from 'fast-png'
import jpeg from 'jpeg-js'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'image-regions')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'image-regions', 'shaderera.item.json'), 'utf8'),
) as {
  files: string[]
}
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'image-regions', f), join(project, f))
}
const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { leaves, loadRegions, maskOf, region } = (await from(
  'src/image/regions.ts',
)) as typeof import('../image-regions/src/image/regions.ts')
const { coverage, imageSize, regionsFromMasks, slug } = (await from(
  'tools/regions-from-masks.ts',
)) as typeof import('../image-regions/tools/regions-from-masks.ts')

const W = 40
const H = 30
/** A whole-image mask: 255 inside [x, y, w, h], 0 elsewhere. */
const rect = (x: number, y: number, w: number, h: number) => {
  const m = new Uint8Array(W * H)
  for (let j = y; j < y + h; j++) m.fill(255, j * W + x, j * W + x + w)
  return m
}
const image = {
  path: 'assets/face.png',
  bytes: encode({ width: W, height: H, data: new Uint8Array(W * H * 3), channels: 3 }),
}

/** A head holding two eyes, and an eyeball inside the left eye: as an analyser answers "eye". */
const made = await regionsFromMasks(image, [
  { label: 'head', mask: rect(2, 2, 36, 26), width: W, height: H },
  { label: 'eye', mask: rect(8, 8, 10, 6), width: W, height: H },
  { label: 'eye', mask: rect(24, 8, 10, 6), width: W, height: H },
  { label: 'eye', mask: rect(11, 10, 4, 2), width: W, height: H },
])

const files = new Map<string, Uint8Array>([
  [image.path, image.bytes],
  ['regions/face/regions.json', new TextEncoder().encode(made.json)],
  ...made.files.map((f) => [`regions/face/${f.name}`, f.bytes] as [string, Uint8Array]),
])
const hostOf = (map: Map<string, Uint8Array>) =>
  ({
    io: {
      read: async (path: string) => {
        const bytes = map.get(path)
        if (!bytes) throw new Error(`No file ${path}`)
        return bytes
      },
    },
  }) as unknown as Host

test('image-regions: painted masks become regions with boxes, centres and parents', async () => {
  const r = await loadRegions(hostOf(files), 'regions/face')
  assert.equal(r.format, 'shaderera.analysis/1')
  assert.equal(r.kind, 'regions')
  assert.deepEqual(
    r.regions.map((q) => [q.id, q.parent ?? null]),
    [
      ['head-0', null],
      ['eye-0', 'head-0'],
      ['eye-1', 'head-0'],
      ['eye-2', 'eye-0'],
    ],
  )
  assert.deepEqual(region(r, 'eye-1').box, [24, 8, 10, 6])
  assert.deepEqual(region(r, 'eye-1').centre, [29, 11])
  assert.deepEqual(region(r, 'eye-1').mask.at, [24, 8])
  // The innermost eyes: the eyeball stands for the left eye, the right eye for itself.
  assert.deepEqual(
    leaves(r, 'eye').map((q) => q.id),
    ['eye-1', 'eye-2'],
  )
  const alpha = await maskOf(hostOf(files), r, region(r, 'eye-2'))
  assert.equal(alpha.length, 4 * 2)
  assert.ok(alpha.every((a) => a === 255))
  assert.throws(() => region(r, 'nose-0'), /has no region "nose-0": it has head-0, eye-0/)
})

test('image-regions: refuses regions measured from other bytes, or that are not regions', async () => {
  const changed = new Map(files)
  changed.set(image.path, new Uint8Array([...image.bytes, 0]))
  await assert.rejects(
    loadRegions(hostOf(changed), 'regions/face'),
    /measured from other bytes than assets\/face\.png/,
  )
  const other = new Map(files)
  other.set(
    'regions/face/regions.json',
    new TextEncoder().encode(JSON.stringify({ format: 'shaderera.analysis/1', kind: 'depth' })),
  )
  await assert.rejects(
    loadRegions(hostOf(other), 'regions/face'),
    /not a shaderera\.analysis\/1 regions artifact/,
  )
  const short = new Map(files)
  short.set('regions/face/eye-2.u8', new Uint8Array(3))
  const r = await loadRegions(hostOf(short), 'regions/face')
  await assert.rejects(maskOf(hostOf(short), r, region(r, 'eye-2')), /has 3 bytes, not 4 × 2/)
})

test('image-regions: a mask PNG is read by its alpha, else its first channel; sizes must agree', async () => {
  const grey = coverage(
    encode({ width: 2, height: 1, data: new Uint8Array([0, 200]), channels: 1 }),
  )
  assert.deepEqual([...grey.mask], [0, 200])
  const rgba = coverage(
    encode({
      width: 2,
      height: 1,
      data: new Uint8Array([255, 255, 255, 10, 0, 0, 0, 255]),
      channels: 4,
    }),
  )
  assert.deepEqual([...rgba.mask], [10, 255])
  await assert.rejects(
    regionsFromMasks(image, [
      { label: 'a', mask: rect(0, 0, 4, 4), width: W, height: H },
      { label: 'b', mask: new Uint8Array(4), width: 2, height: 2 },
    ]),
    /The b mask is 2×2; it must be 40×30, the size of assets\/face\.png/,
  )
  await assert.rejects(
    regionsFromMasks(image, [{ label: 'a', mask: new Uint8Array(W * H), width: W, height: H }]),
    /The a mask has no pixel over half coverage/,
  )
})

test('image-regions: masks must be the size of the image, read from its PNG or JPEG header', async () => {
  assert.deepEqual(imageSize(image.bytes), { width: W, height: H })
  const jpg = jpeg.encode({ width: 33, height: 21, data: new Uint8Array(33 * 21 * 4) }, 80).data
  assert.deepEqual(imageSize(new Uint8Array(jpg)), { width: 33, height: 21 })
  assert.throws(
    () => imageSize(new Uint8Array([1, 2, 3]), 'x.webp'),
    /x\.webp is not a PNG or JPEG/,
  )
  // Masks that agree with each other but not with the photograph.
  const small = { label: 'a', mask: new Uint8Array(20 * 15).fill(255), width: 20, height: 15 }
  await assert.rejects(
    regionsFromMasks(image, [small]),
    /it must be 40×30, the size of assets\/face\.png/,
  )
})

test('image-regions: ids are safe file names, and labels that read the same do not collide', async () => {
  assert.equal(slug('Cat Head'), 'cat-head')
  assert.equal(slug('../../etc/passwd'), 'etc-passwd')
  assert.equal(slug('ตา'), 'region')
  const made = await regionsFromMasks(image, [
    { label: 'cat head', mask: rect(2, 2, 10, 10), width: W, height: H },
    { label: 'cat-head', mask: rect(20, 2, 10, 10), width: W, height: H },
    { label: '../x', mask: rect(2, 20, 4, 4), width: W, height: H },
  ])
  assert.deepEqual(
    made.files.map((f) => f.name),
    ['cat-head-0.u8', 'cat-head-1.u8', 'x-0.u8'],
  )
  assert.deepEqual(
    (JSON.parse(made.json) as { regions: { label: string }[] }).regions.map((r) => r.label),
    ['cat head', 'cat-head', '../x'],
  )
})

test('image-regions: the importer keeps to the project, to one image per folder, and leaves no stale masks', () => {
  const root = join(plugins, 'out', 'image-regions-cli')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(join(root, 'masks'), { recursive: true })
  const png = (m: Uint8Array) => encode({ width: W, height: H, data: m, channels: 1 })
  writeFileSync(join(root, 'assets', 'face.png'), image.bytes)
  writeFileSync(join(root, 'assets', 'other.png'), image.bytes)
  writeFileSync(join(root, 'masks', 'head.png'), png(rect(2, 2, 36, 26)))
  writeFileSync(join(root, 'masks', 'eye.png'), png(rect(8, 8, 10, 6)))
  const tool = join(project, 'tools', 'regions-from-masks.ts')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: 'utf8' })

  const first = run('assets/face.png', 'head=masks/head.png', 'eye=masks/eye.png')
  assert.equal(first.status, 0, first.stderr)
  const doc = JSON.parse(readFileSync(join(root, 'regions', 'face', 'regions.json'), 'utf8'))
  assert.equal(doc.source.path, 'assets/face.png')
  assert.ok(existsSync(join(root, 'regions', 'face', 'eye-0.u8')))

  const again = run('assets/face.png', 'head=masks/head.png')
  assert.equal(again.status, 0, again.stderr)
  assert.ok(!existsSync(join(root, 'regions', 'face', 'eye-0.u8')), 'the old eye mask is gone')

  const clash = run('assets/other.png', 'head=masks/head.png', '--out', 'regions/face')
  assert.equal(clash.status, 2)
  assert.match(clash.stderr, /regions\/face holds the regions of assets\/face\.png/)

  const outside = run(join(plugins, 'image-regions', 'README.md'), 'head=masks/head.png')
  assert.equal(outside.status, 2)
  assert.match(outside.stderr, /is outside this project/)
})
