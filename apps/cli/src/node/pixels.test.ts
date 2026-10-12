import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportVideo } from '../cli/render.ts'
import { encodePng } from '../deliver/png.ts'
import { openBrowserChild } from './browser.ts'
import { buildForNode } from './build.ts'
import { type Child, openChild } from './child.ts'
import { findProject } from './project.ts'

/**
 * The pixel contract (docs/determinism.md, Pixels): both hosts return straight RGBA, PNGs
 * keep it byte for byte, and an mp4 shows it matted over black. Fixture: straight (200,120,40,128)
 * everywhere, premultiplied (50,50,50,128) over the right half. Needs Chrome and ffmpeg: without
 * them these fail, they do not skip.
 */
const project = await findProject(join(import.meta.dirname, 'fixtures', 'alpha'))
const { width, height } = project.manifest
const entryFile = await buildForNode(project)
// The same film beside a link to the `webgpu` (Dawn) fixtures/particles installs: the Node host
// then composites on the GPU and exports yuv420p (decision 0007).
const gpuRoot = join(mkdtempSync(join(tmpdir(), 'shaderera-alpha-gpu-')), 'film')
cpSync(join(import.meta.dirname, 'fixtures', 'alpha'), gpuRoot, { recursive: true })
mkdirSync(join(gpuRoot, 'node_modules'))
symlinkSync(
  realpathSync(join(import.meta.dirname, '../../fixtures/particles/node_modules/webgpu')),
  join(gpuRoot, 'node_modules', 'webgpu'),
  'junction',
)
const gpuProject = await findProject(gpuRoot)
const gpuEntry = await buildForNode(gpuProject)
type Params = { [key: string]: boolean }
const hosts: [string, (params?: Params) => Promise<Child>, typeof project][] = [
  ['node', (params = {}) => openChild(project, { entryFile, params }), project],
  [
    'node with a GPU',
    (params = {}) => openChild(gpuProject, { entryFile: gpuEntry, params }),
    gpuProject,
  ],
  ['browser', (params = {}) => openBrowserChild(project, { params }), project],
]

/** Straight RGBA, worked by hand: the left half, and the veil over it on the right. */
const LEFT = [200, 120, 40, 128]
// Premultiplied: veil 50 + base (100.4, 60.2, 20.1) x (1 - 128/255); alpha 128 + 128 x (1 - 128/255).
const RIGHT = [133, 106, 80, 192]
/** The same over black: straight colour times alpha. */
const MATTE_LEFT = [100, 60, 20]
const MATTE_RIGHT = [100, 80, 60]

const at = (px: Uint8Array, x: number, y: number) => [
  ...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
]
const near = (got: number[], want: number[], tolerance: number, what: string) =>
  assert.ok(
    want.every((w, i) => Math.abs((got[i] ?? -999) - w) <= tolerance),
    `${what}: got ${got}, want ${want} ±${tolerance}`,
  )
const decode = (file: string) =>
  spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]).stdout as Buffer

for (const [name, open, film] of hosts) {
  test(`${name}: straight RGBA at the boundary, byte-exact PNG, mp4 matted over black`, async () => {
    const child = await open()
    try {
      // A host with a GPU (Dawn here, WebGPU in Chrome) exports yuv420p it made itself; the
      // Node host without one hands ffmpeg RGBA.
      assert.equal(!!child.has.yuv, name !== 'node')
      const { pixels } = await child.render(0, 'final')
      // Chrome's canvas keeps premultiplied colour, so a straight byte may move by 1.
      near(at(pixels, 4, 8), LEFT, 1, 'left')
      near(at(pixels, 28, 8), RIGHT, 1, 'right')
      const preview = (await child.render(0, 'preview')).pixels
      assert.deepEqual(preview, pixels, 'preview and final agree on an opaque-free frame')

      const dir = mkdtempSync(join(tmpdir(), 'shaderera-alpha-'))
      const png = join(dir, 'frame.png')
      writeFileSync(png, encodePng(pixels, width, height))
      assert.deepEqual(new Uint8Array(decode(png)), pixels, 'PNG round trip')

      const out = join(dir, 'frame.mp4')
      await exportVideo(film, child, { out })
      const video = new Uint8Array(decode(out))
      // H.264 at crf 18, 4:2:0, limited range: flat areas, sampled away from the edge.
      near(at(video, 4, 8).slice(0, 3), MATTE_LEFT, 4, 'mp4 left')
      near(at(video, 28, 8).slice(0, 3), MATTE_RIGHT, 4, 'mp4 right')
      assert.equal(at(video, 4, 8)[3], 255)
    } finally {
      await child.close()
    }
  })

  test(`${name}: a final render with an unfinished layer fails, and export leaves no file`, async () => {
    const child = await open({ unfinished: true })
    try {
      await child.render(0, 'preview')
      await assert.rejects(child.render(0, 'final'), /unfinished layer \(veil: final: false\)/)
      const out = join(mkdtempSync(join(tmpdir(), 'shaderera-unfinished-')), 'x.mp4')
      await assert.rejects(exportVideo(film, child, { out }), /unfinished layer/)
      assert.equal(existsSync(out), false)
    } finally {
      await child.close()
    }
  })
}
