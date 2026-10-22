import assert from 'node:assert/strict'
import { cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { frameAt, type Json } from '@shaderera/core'
import { lightReference, p010Reference, rgb10Reference, sampleClips } from '@shaderera/core/host'
import { tempDir } from '../fixtures/temp.ts'
import { buildForNode } from './build.ts'
import type { Child } from './child.ts'
import { captions, clips, FAILS_AT, paint } from './fixtures/contract/src/composition.ts'
import { fixture } from './fixtures/hdr/src/composition.ts'
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

/**
 * The HDR exactness fixture (docs/adr/0023, decision 4) through each host that composites on the
 * GPU: its 10-bit codes against the float64 reference of its layers, its P010 against the float64
 * reference from those codes, and its light levels.
 */
const hdrRoot = join(tempDir('contract-hdr'), 'film')
cpSync(join(import.meta.dirname, 'fixtures', 'hdr'), hdrRoot, { recursive: true })
mkdirSync(join(hdrRoot, 'node_modules'))
symlinkSync(
  realpathSync(join(import.meta.dirname, '../../fixtures/particles/node_modules/webgpu')),
  join(hdrRoot, 'node_modules', 'webgpu'),
  'junction',
)
const hdrProject = await findProject(hdrRoot)
const hdr10 = hdrProject.manifest.hdr10 as NonNullable<typeof hdrProject.manifest.hdr10>
const HDR_T = 0.5
const words = (bytes: Uint8Array) =>
  new Uint32Array(bytes.slice().buffer, 0, bytes.length / 4) as Uint32Array<ArrayBuffer>
const channels = (codes: Uint32Array) =>
  Array.from(codes).flatMap((w) => [w & 1023, (w >>> 10) & 1023, (w >>> 20) & 1023])
/** The worst difference, the share off by one, and whether the top codes are equal. */
const compare = (got: number[], want: number[]) => {
  let worst = 0
  let offByOne = 0
  for (let i = 0; i < want.length; i++) {
    const d = Math.abs((got[i] as number) - (want[i] as number))
    worst = Math.max(worst, d)
    if (d === 1) offByOne++
  }
  const top = (a: number[]) => a.reduce((m, v) => Math.max(m, v), 0)
  return { worst, share: offByOne / want.length, top: top(got) === top(want) }
}

for (const name of ['node', 'browser'] as const) {
  describe(`${name}: an hdr10 render composites in HDR only`, () => {
    let child: Child
    before(async () => {
      child = await (
        await hostOpener(name, hdrProject, {
          params: {},
          range: 'hdr10',
          build: async () => ({ project: hdrProject, entryFile: await buildForNode(hdrProject) }),
        })
      )()
    })
    after(async () => {
      await child?.close()
    })

    test('the codes, the P010 and the light levels match the float64 reference', async (t) => {
      const { width: w, height: h, fps } = hdrProject.manifest
      assert.equal(child.has.yuv, false)
      assert.equal(child.has.deep, false)
      const rgb10 = await child.render(HDR_T, 'final', 'rgb10')
      const codes = words(rgb10.pixels)
      const { pq, linear, graphics } = fixture(w, h)
      const want = rgb10Reference(
        [
          { data: pq, alpha: 'straight', light: { transfer: 'pq', primaries: 'bt2020' } },
          {
            data: linear,
            alpha: 'premultiplied',
            light: { transfer: 'linear', primaries: 'bt2020' },
          },
          { data: graphics, alpha: 'straight' },
        ],
        w,
        h,
        hdr10,
        frameAt(HDR_T, fps),
      )
      const r = compare(channels(codes), channels(want))
      assert.ok(r.worst <= 1 && r.share < 0.005 && r.top, JSON.stringify(r))
      const p010 = await child.render(HDR_T, 'final', 'p010')
      assert.deepEqual(p010.layers, [{ name: 'pq' }, { name: 'linear' }, { name: 'graphics' }])
      const got = new Uint16Array(p010.pixels.slice().buffer)
      const p = compare(
        Array.from(got, (v) => v >> 6),
        Array.from(p010Reference(codes, w, h), (v) => v >> 6),
      )
      assert.ok(p.worst <= 1 && p.share < 1e-4 && p.top, JSON.stringify(p))
      const light = lightReference(codes)
      assert.deepEqual(p010.light, rgb10.light)
      assert.equal(p010.light?.maxCll, light.maxCll)
      const fall = Math.abs((p010.light?.maxFall ?? 0) - light.maxFall) / light.maxFall
      assert.ok(fall < 1e-4)
      t.diagnostic(
        `codes: worst ${r.worst}, ${(r.share * 100).toFixed(4)}% off by one; P010: worst ${p.worst}, ${(p.share * 100).toFixed(4)}% off by one; MaxCLL ${p010.light?.maxCll}, MaxFALL ${p010.light?.maxFall} vs ${light.maxFall}`,
      )
    })

    test('an SDR output is refused', async () => {
      await assert.rejects(
        child.render(HDR_T, 'final'),
        /An hdr10 render comes out as rgb10 or p010, not rgba/,
      )
    })
  })
}
