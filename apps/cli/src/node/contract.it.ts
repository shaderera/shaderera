import assert from 'node:assert/strict'
import { cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { Json } from '@shaderera/core'
import { sampleClips } from '@shaderera/core/host'
import { tempDir } from '../fixtures/temp.ts'
import { buildForNode } from './build.ts'
import type { Child } from './child.ts'
import { captions, clips, FAILS_AT, paint } from './fixtures/contract/src/composition.ts'
import { memoryChild, toYuv420p } from './fixtures/memory-child.ts'
import type { HostName } from './host-of.ts'
import { hostOpener } from './open-host.ts'
import { findProject } from './project.ts'

/**
 * The Child contract (decision 0006: the browser host gives every command the same Child the Node
 * host gives): each case runs against the Node host, the browser host and the in-memory adapter
 * the logic tests use, on fixtures/contract. The Node host has `webgpu` (Dawn), so all three
 * composite on the GPU or as if they did (decision 0007). Needs a GPU and Chrome: without them the
 * host cases fail, they do not skip.
 */
const root = join(tempDir('contract'), 'film')
cpSync(join(import.meta.dirname, 'fixtures', 'contract'), root, { recursive: true })
mkdirSync(join(root, 'node_modules'))
symlinkSync(
  realpathSync(join(import.meta.dirname, '../../fixtures/particles/node_modules/webgpu')),
  join(root, 'node_modules', 'webgpu'),
  'junction',
)
const project = await findProject(root)
const { width, height, duration } = project.manifest

const SEED = 7
type Open = (params: { silent: boolean }) => Promise<Child>
const host =
  (name: HostName): Open =>
  async (params) =>
    (
      await hostOpener(name, project, {
        params,
        // A job's seed, which each host must hand the source (host.seed).
        seed: SEED,
        build: async () => ({ project, entryFile: await buildForNode(project) }),
      })
    )()
const memory: Open = async ({ silent }) =>
  memoryChild({
    size: { width, height },
    frame: (t) => {
      if (Math.abs(t - FAILS_AT) < 1e-9) throw new Error(`The film fails at ${FAILS_AT} s.`)
      return { pixels: paint(t, width, height), layers: [{ name: 'card' }] }
    },
    inspect: (t) => ({ card: { red: Math.round(20 + 200 * t), t }, seed: SEED }) as Json,
    clips: silent ? null : sampleClips(clips, duration),
    captions: silent ? null : captions,
  })

const near = (got: Uint8Array | Uint16Array, want: ArrayLike<number>, tolerance: number) => {
  assert.equal(got.length, want.length)
  for (let i = 0; i < got.length; i++)
    if (Math.abs((got[i] as number) - (want[i] as number)) > tolerance)
      assert.fail(`byte ${i}: got ${got[i]}, want ${want[i]} ±${tolerance}`)
}

for (const [name, open] of [
  ['node', host('node')],
  ['browser', host('browser')],
  ['memory', memory],
] as const) {
  describe(`${name}: the Child contract`, () => {
    let child: Child
    let silent: Child
    before(async () => {
      ;[child, silent] = await Promise.all([open({ silent: false }), open({ silent: true })])
    })
    after(async () => {
      await Promise.all([child?.close(), silent?.close()])
    })

    test('opens with what the source has, compositing on the GPU', () => {
      assert.deepEqual(child.has, {
        inspect: true,
        pick: false,
        camera: false,
        sequential: false,
        yuv: true,
        deep: true,
      })
    })

    test('a frame is straight RGBA at the frame size, with its layers; yuv420p and rgba64 too', async () => {
      const want = paint(0.5, width, height)
      const final = await child.render(0.5, 'final')
      assert.ok(final.pixels instanceof Uint8Array)
      near(final.pixels, want, 1)
      assert.deepEqual(final.layers, [{ name: 'card' }])
      assert.deepEqual((await child.render(0.5, 'preview')).pixels, final.pixels)
      // Matted over black, BT.709 limited range, 4:2:0: Y plane then Cb then Cr.
      near((await child.render(0.5, 'final', 'yuv420p')).pixels, toYuv420p(want, width, height), 1)
      const deep = (await child.render(0.5, 'final', 'rgba64')).pixels
      assert.equal(deep.length, width * height * 8)
      near(
        new Uint16Array(deep.slice().buffer),
        Array.from(want, (b) => b * 257),
        300,
      )
    })

    test('sound, captions, inspect and the rest', async () => {
      assert.deepEqual(await child.audio(), sampleClips(clips, duration))
      assert.deepEqual(await child.captions(), captions)
      assert.deepEqual(await child.inspect(0.5), { card: { red: 120, t: 0.5 }, seed: SEED })
      assert.equal(await child.pick(0, 1, 1), null)
      assert.equal(await child.camera(0), null)
      assert.equal(await child.seeks(), null)
      assert.deepEqual(await child.text(0), [])
      assert.deepEqual(await child.fonts(), { fonts: [], failures: [] })
      assert.deepEqual(await child.clock(), { date: 0, performance: 0 })
      assert.ok(['node', 'browser'].includes((await child.identity()).host))
    })

    test('a source without audio() or captions() gives null for both', async () => {
      assert.equal(await silent.audio(), null)
      assert.equal(await silent.captions(), null)
    })

    test("a source's error fails that call with its message; the next call renders", async () => {
      await assert.rejects(child.render(FAILS_AT, 'final'), /The film fails at 0\.7 s\./)
      near((await child.render(0.5, 'final')).pixels, paint(0.5, width, height), 1)
    })

    test('after close, a call fails', async () => {
      await silent.close()
      await assert.rejects(silent.render(0, 'final'))
    })
  })
}
