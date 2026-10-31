import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { Manifest } from '@shaderera/core'
import { cli } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'
import { boxFrame, memoryChild } from '../node/fixtures/memory-child.ts'
import { CAUSES, checkChild, diffP010, footageNotes, keyframeNotes } from './check.ts'

const manifest = { fps: 10, duration: 1, width: 64, height: 36 } as Manifest
const size = { width: 64, height: 36 }

const hdr10 = {
  graphicsWhite: 203,
  mastering: { peak: 1000, min: 0.005, primaries: 'p3-d65' as const },
  dither: 'tpdf' as const,
}

test('an hdr10 check hashes P010, reports the light, and fails a frame past the peak', async () => {
  const film = memoryChild({ size, frame: boxFrame(64, 36), hdr: { hdr10, fps: 10 } })
  assert.equal(film.has.p010, true)
  assert.equal(film.has.yuv, false)
  const ok = await checkChild(film, manifest, { samples: 4 })
  assert.deepEqual(ok.failures, [])
  // An opaque red box over transparent black: BT.709 red at Graphics White is R 0.627 × 203 in BT.2020.
  assert.ok(ok.light && Math.abs(ok.light.maxCll - 0.6274 * 203) < 2, JSON.stringify(ok.light))
  assert.ok(ok.light.maxFall > 0 && ok.light.maxFall < ok.light.maxCll)
  assert.deepEqual(ok.previewVsFinal, { mean: 0, max: 0, at: ok.previewVsFinal.at })
  // A display whose peak is below that red: the frame passes it.
  const dim = { ...hdr10, mastering: { ...hdr10.mastering, peak: 100 } }
  const over = memoryChild({ size, frame: boxFrame(64, 36), hdr: { hdr10: dim, fps: 10 } })
  await assert.rejects(
    checkChild(over, manifest, { samples: 2 }),
    /above the mastering display's peak of 100 cd\/m²/,
  )
  // An hdr10 host gives nothing in SDR.
  await assert.rejects(
    film.render(0, 'final'),
    /An hdr10 render comes out as rgb10 or p010, not rgba/,
  )
})

test('a check of fewer than two timestamps is refused: it could never fail', async () => {
  const child = memoryChild({ size })
  for (const times of [0, 1, Number.NaN, 2.5])
    await assert.rejects(checkChild(child, manifest, { samples: times }), /2 or more/)
})

test('check passes a film that is a function of t, inspect included, and fails one with state', async () => {
  const film = memoryChild({ size, frame: boxFrame(64, 36), inspect: (t) => ({ x: 20 - 10 * t }) })
  const ok = await checkChild(film, manifest, { samples: 5 })
  assert.deepEqual(ok.failures, [])
  assert.equal(ok.what, 'inspect + pixels')
  assert.deepEqual(ok.previewVsFinal, { mean: 0, max: 0, at: ok.previewVsFinal.at })
  assert.equal(ok.seeks, null)

  // Each frame a little brighter than the one before: a revisit gives other pixels.
  let n = 0
  const stateful = memoryChild({ size, frame: () => new Uint8Array(64 * 36 * 4).fill(n++) })
  const bad = await checkChild(stateful, manifest, { samples: 5 })
  assert.ok(bad.failures.length > 0)
  assert.equal(bad.what, 'pixels')
})

test('a film that uses Math.random fails check at its first t, with the frame and the usual causes', async () => {
  const root = tempDir('random')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/composition.ts', fps: 30, duration: 2, width: 8, height: 8 }),
  )
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `const open = ({ io }) => {
  const canvas = io.canvas(8, 8)
  return {
    render: async () => {
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = \`rgb(\${Math.floor(Math.random() * 256)}, 0, 0)\`
      ctx.fillRect(0, 0, 8, 8)
      return { color: canvas }
    },
  }
}
export default open
`,
  )
  const r = await cli('check', '--samples', '5', '--root', root)
  assert.equal(r.status, 1, r.stderr)
  assert.match(
    r.stdout,
    /^✗ not deterministic: differs at t=[\d.]+ \(frame \d+\), the first difference found; check stops there$/m,
  )
  assert.match(r.stdout, /^ {2}✗ t=[\d.]+ (rendered first|after t=[\d.]+), pixels: /m)
  assert.ok(r.stdout.includes(`  ${CAUSES}`), r.stdout)
  const json = JSON.parse((await cli('check', '--samples', '5', '--root', root, '--json')).stdout)
  const [f] = json.findings.filter((x: { code: string }) => x.code === 'determinism')
  assert.equal(f.t[0], Math.round(f.t[0] * 1000) / 1000)
  assert.doesNotMatch(f.message, /after t=-/)
})

test("a type error in src/ fails check with its file and line; --no-types skips the project's tsc", async () => {
  const root = tempDir('types')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  // The project's own typescript: this repo's, linked in.
  const typescript = dirname(createRequire(import.meta.url).resolve('typescript/package.json'))
  symlinkSync(typescript, join(root, 'node_modules', 'typescript'), 'junction')
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/composition.ts', fps: 10, duration: 1, width: 8, height: 8 }),
  )
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, lib: ['ES2023'] },
      include: ['src'],
    }),
  )
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `const width: number = 8
const label: number = 'eight'
const open = () => ({ render: () => [], width, label })
export default open
`,
  )
  const r = await cli('check', '--samples', '2', '--root', root, '--json')
  assert.equal(r.status, 1, r.stdout)
  const [f] = JSON.parse(r.stdout).findings.filter((x: { code: string }) => x.code === 'type')
  assert.deepEqual([f.severity, f.file, f.line], ['error', 'src/composition.ts', 2])
  assert.match(f.message, /^TS2322: Type 'string' is not assignable to type 'number'/)
  assert.equal((await cli('check', '--samples', '2', '--root', root, '--no-types')).status, 0)
})

test('diffP010 compares P010 bytes that start at an odd offset', () => {
  // A Node Buffer can hand back bytes at any offset of its pool: view those, copy these.
  const words = new Uint16Array([0, 512 << 6, 1023 << 6, 64 << 6])
  const odd = new Uint8Array(words.byteLength + 1)
  odd.set(new Uint8Array(words.buffer), 1)
  const a = odd.subarray(1)
  assert.equal(a.byteOffset % 2, 1)
  assert.deepEqual(diffP010(a, new Uint8Array(words.buffer)), { mean: 0, max: 0 })
  const b = new Uint16Array([1 << 6, 512 << 6, 1023 << 6, 60 << 6])
  assert.deepEqual(diffP010(a, new Uint8Array(b.buffer)), { mean: 5 / 4, max: 4 })
})

test("check notes the project's own clips whose keyframes are more than 2 s apart", () => {
  const root = join('/films', 'a')
  const gaps = new Map([
    [join(root, 'assets', 'footage', 'long.mp4'), 250 / 30],
    [join(root, 'assets', 'footage', 'short.mp4'), 1],
    [join(root, 'assets', 'footage', 'two.mp4'), 2],
    [join(root, '..clip.mp4'), 3],
    [join(root, 'node_modules', 'pkg', 'clip.mp4'), 9],
    [join('/films', 'b', 'other.mp4'), 9],
  ])
  const note = (path: string, s: string) =>
    `${path}: keyframes up to ${s} s apart, so every seek in it (check, still, the studio scrub, a chunk start) decodes up to ${s} s of frames first. Trim it with a short GOP (-g <fps>, docs/guides/footage.md).`
  // A file named ..clip.mp4 is inside; an installed package's clip is not the project's own.
  assert.deepEqual(keyframeNotes(root, gaps), [
    note('assets/footage/long.mp4', '8.3'),
    note('..clip.mp4', '3.0'),
  ])
})

test("check warns of the project's own footage of more than 8 bits with no space declared or read only at 8 bits (#575)", () => {
  const root = join('/films', 'a')
  const f = { bits: 10, declared: true, at8: false, at10: true } as const
  const deep = new Map([
    [join(root, 'ok.mov'), f],
    [join(root, 'log.mov'), { ...f, declared: false }],
    [join(root, 'flat.mov'), { ...f, bits: 12, at8: true, at10: false } as const],
    [join(root, 'node_modules', 'pkg', 'clip.mov'), { ...f, declared: false }],
  ])
  assert.deepEqual(footageNotes(root, deep), [
    {
      code: 'footage-space',
      message:
        "log.mov: 10-bit footage with no colour space declared, so a grade takes its codes for Rec.709 video. Say what it is where the film opens it: io.video(path, { transfer, gamut }), for example { transfer: 'slog3', gamut: 'sgamut3cine' }.",
    },
    {
      code: 'footage-bits',
      message:
        "flat.mov: 12-bit footage read only at 8 bits, so a grade that lifts or stretches it bands. Ask for its 10-bit planes: videoTexture(host.gpu, clip, { bits: 10 }) or clip.frame(i, { format: 'yuv420p10' }).",
    },
  ])
})
