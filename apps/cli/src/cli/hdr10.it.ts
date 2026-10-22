import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkManifest, lightReference, rgb10Reference } from '@shaderera/core/host'
import type { BatchIndex } from '../deliver/batch.ts'
import type { ChunkRecord } from '../deliver/chunks.ts'
import { tempDir } from '../fixtures/temp.ts'
import { fixture } from '../node/fixtures/hdr/src/composition.ts'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { hasHevcNvenc, hdr10Problem, masteringOf, probe } from './ffmpeg.ts'
import { exportVideo } from './render.ts'

// The HDR exactness fixture (docs/adr/0023) as a film that opts in: rendered to HDR10 mp4s and
// probed for the tags, and for the display it declares and the light its frames measure.
const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })
const problem = spawnSync('ffmpeg', ['-version']).status === 0 ? hdr10Problem() : 'no ffmpeg'

/** The fixture in its own folder, with the Dawn the Node host composites on. */
const film = () => {
  const root = join(tempDir('hdr10'), 'film')
  cpSync(fileURLToPath(new URL('../node/fixtures/hdr/', import.meta.url)), root, {
    recursive: true,
  })
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(
    realpathSync(
      fileURLToPath(new URL('../../fixtures/particles/node_modules/webgpu', import.meta.url)),
    ),
    join(root, 'node_modules', 'webgpu'),
    'junction',
  )
  return root
}

const manifest = checkManifest(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../node/fixtures/hdr/shaderera.json', import.meta.url)),
      'utf8',
    ),
  ),
)
const hdr10 = manifest.hdr10 as NonNullable<typeof manifest.hdr10>

/** The light of the fixture's frames from the HDR compositor's float64 reference: the most of each. */
const referenceLight = () => {
  const { width: w, height: h } = manifest
  const { pq, linear, graphics } = fixture(w, h)
  let maxCll = 0
  let maxFall = 0
  // Its frames differ only by the dither, seeded by the frame index.
  for (let frame = 0; frame < manifest.fps * manifest.duration; frame++) {
    const light = lightReference(
      rgb10Reference(
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
        frame,
      ),
    )
    maxCll = Math.max(maxCll, light.maxCll)
    maxFall = Math.max(maxFall, light.maxFall)
  }
  return { maxCLL: Math.ceil(maxCll), maxFALL: Math.ceil(maxFall) }
}

/** The file's tags, and its boxes and first-frame SEI equal to the declared display and these levels. */
const assertHdr10 = (file: string, levels: { maxCLL: number; maxFALL: number }) => {
  const p = probe(file)
  const v = p.video
  assert.equal(v?.codec, 'hevc')
  assert.equal(v?.profile, 'Main 10')
  assert.equal(v?.pixFmt, 'yuv420p10le')
  assert.equal(v?.frames, 10)
  assert.deepEqual(v?.color, {
    matrix: 'bt2020nc',
    primaries: 'bt2020',
    transfer: 'smpte2084',
    range: 'tv',
  })
  const h = v?.hdr10
  assert.equal(h?.codecTag, 'hvc1')
  assert.equal(h?.chroma, 'topleft')
  // BT.2020 primaries, D65, 10 000 and 0.0001 cd/m², in the units of each field.
  const units = (d: unknown) =>
    JSON.stringify(d, (_, x) => (typeof x === 'number' ? Math.round(x * 50000) : x))
  const display = masteringOf(hdr10.mastering)
  assert.equal(units(h?.mastering), units(display))
  assert.equal(units(h?.sei?.mastering), units(display))
  assert.deepEqual(h?.light, levels)
  assert.deepEqual(h?.sei?.light, levels)
  return p
}

test('render --hdr10: an HDR10 mp4 tagged, with the declared display and the measured light in its boxes and SEI', {
  skip: problem,
}, () => {
  const root = film()
  const levels = referenceLight()
  // The fixture's PQ peak code and its mean: known numbers.
  assert.equal(levels.maxCLL, 10000)
  for (const encoder of ['x265', 'nvenc']) {
    if (encoder === 'nvenc' && !hasHevcNvenc(manifest.width, manifest.height)) continue
    const out = join(root, 'out', `${encoder}.mp4`)
    const r = cli(root, 'render', '--hdr10', '--encoder', encoder, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`10 frames in .* ${encoder}\\n`))
    assert.match(r.stdout, /light: MaxCLL 10000 cd\/m², MaxFALL [\d.]+ cd\/m² measured/)
    assertHdr10(out, levels)
  }
  // Its one chunk was beside the file, and is gone.
  assert.deepEqual(
    readdirSync(join(root, 'out')).filter((f) => !f.endsWith('.mp4')),
    [],
  )
  // The film's SDR render is its own: H.264 BT.709, nothing in it declares light.
  const sdr = cli(root, 'render', '--out', join(root, 'out', 'sdr.mp4'))
  assert.equal(sdr.status, 0, sdr.stderr)
  const p = probe(join(root, 'out', 'sdr.mp4'))
  assert.equal(p.video?.codec, 'h264')
  assert.equal(p.video?.color?.transfer, 'bt709')
  assert.equal(p.video?.hdr10, undefined)
})

test('render --hdr10 --format prores-hq | prores-4444: ProRes from the R’G’B’ codes, tagged HDR10, the display and light in the mov’s boxes', {
  skip: problem,
}, () => {
  const root = film()
  const levels = referenceLight()
  const units = (d: unknown) =>
    JSON.stringify(d, (_, x) => (typeof x === 'number' ? Math.round(x * 50000) : x))
  for (const [format, tag, pixFmt] of [
    ['prores-hq', 'apch', 'yuv422p10le'],
    ['prores-4444', 'ap4h', 'yuv444p12le'],
  ] as const) {
    const out = join(root, 'out', `${format}.mov`)
    const r = cli(root, 'render', '--hdr10', '--format', format, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /10 frames in .* prores\n/)
    const v = probe(out).video
    assert.equal(v?.codec, 'prores')
    assert.equal(v?.pixFmt, pixFmt)
    assert.equal(v?.frames, 10)
    assert.deepEqual(v?.color, {
      matrix: 'bt2020nc',
      primaries: 'bt2020',
      transfer: 'smpte2084',
      range: 'tv',
    })
    // The boxes; ProRes has no chroma site and no SEI.
    assert.equal(v?.hdr10?.codecTag, tag)
    assert.equal(v?.hdr10?.chroma, undefined)
    assert.equal(units(v?.hdr10?.mastering), units(masteringOf(hdr10.mastering)))
    assert.deepEqual(v?.hdr10?.light, levels)
  }
  // A png is still refused: a PQ PNG needs cICP.
  const png = cli(root, 'job', '--name', 'p', '--hdr10', '--png')
  assert.equal(png.status, 2)
  assert.match(png.stderr, /a PQ PNG needs a cICP chunk/)
})

test('deliver --hdr10 --sdr: the HDR10 master passes a YouTube HDR placement, and the film’s own SDR render its own', {
  skip: problem,
}, () => {
  const root = film()
  const specs = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../packages/plugins/format-placement-specs/delivery/placements.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  )
  writeFileSync(
    join(root, 'requirements.json'),
    JSON.stringify({
      version: 1,
      placements: {
        main: specs['youtube-hdr'],
        'main:sdr': { containers: ['mp4'], transfer: ['bt709'], bitDepth: [8] },
      },
    }),
  )
  // Without --hdr10 the file is SDR, and the placement names the flag.
  const plain = cli(root, 'deliver', '--name', 'sdr')
  assert.equal(plain.status, 1, plain.stderr)
  assert.match(plain.stdout, /failing: placement/)
  const indexOf = (batch: string) =>
    JSON.parse(
      readFileSync(join(root, 'out', 'deliveries', batch, 'index.json'), 'utf8'),
    ) as BatchIndex
  assert.match(
    indexOf('sdr').outputs[0]?.checks.find((c) => c.id === 'placement')?.detail ?? '',
    /^transfer bt709, not smpte2084 or arib-std-b67 \(--hdr10\); 8-bit video, not 10 or 12 \(--hdr10\); no HDR10 metadata/,
  )
  const r = cli(root, 'deliver', '--hdr10', '--sdr', '--master', '--name', 'yt')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const index = indexOf('yt')
  const [hdr, sdr] = index.outputs
  assert.equal(index.outputs.length, 2)
  assert.equal(hdr?.job, 'yt-main')
  assert.equal(hdr?.range, 'hdr10')
  assert.equal(sdr?.job, 'yt-main-sdr')
  assert.equal(sdr?.sdrOf, 'yt-main')
  for (const o of index.outputs) {
    assert.equal(o.status, 'pass', JSON.stringify(o.checks))
    const placement = o.checks.find((c) => c.id === 'placement')
    assert.equal(placement?.status, 'pass', placement?.detail)
    assert.equal(placement?.required, true)
  }
  assert.match(
    hdr?.checks.find((c) => c.id === 'placement')?.measured ?? '',
    /hevc 1024×64 10 fps, .*10-bit smpte2084, MaxCLL 10000 \/ MaxFALL \d+ cd\/m²$/,
  )
  // The master as its encode declared it, with the light the reference measures.
  assertHdr10(join(root, 'out', 'deliveries', 'yt', 'yt-main', 'yt-main.mp4'), referenceLight())
  // The SDR render is the film's own, not one made from the HDR: H.264 BT.709 at 8 bits.
  assert.equal(sdr?.probe?.video?.codec, 'h264')
  assert.equal(sdr?.probe?.video?.color?.transfer, 'bt709')
  // The hdr10 review reads the master's light as numbers.
  assert.equal(hdr?.checks.find((c) => c.id === 'hdr10')?.status, 'info')
})

test('an HDR10 preroll the source fills counts in the light levels; a black one is P010 black', {
  skip: problem,
}, async () => {
  const hdr = {
    mastering: { peak: 1000, min: 0.005, primaries: 'p3-d65' as const },
    dither: 'none' as const,
  }
  const size = { width: 64, height: 36 }
  // White before the programme (the preroll's negative t), a dark grey in it.
  const frame = (t: number) => new Uint8Array(64 * 36 * 4).fill(t < 0 ? 255 : 40)
  for (const fill of ['source', 'black'] as const) {
    const project = memoryProject({ hdr10: hdr, preroll: { seconds: 0.5, fill } })
    const child = memoryChild({
      size,
      frame,
      hdr: { hdr10: { graphicsWhite: 203, ...hdr }, fps: 10 },
    })
    const out = join(project.root, 'out', 'film.mp4')
    const r = await exportVideo(project, child, { out, revision: 'r', encoder: 'x265' })
    assert.equal(r.bits, 10)
    assert.equal(r.probe.video?.frames, 15)
    // Graphics White from the preroll, or the programme's grey alone.
    const cll = r.light?.maxCll ?? 0
    assert.ok(fill === 'source' ? Math.abs(cll - 203) < 2 : cll < 10, `${fill}: ${cll}`)
    assert.deepEqual(r.probe.video?.hdr10?.light, {
      maxCLL: Math.ceil(cll),
      maxFALL: Math.ceil(r.light?.maxFall ?? 0),
    })
  }
})

test('an hdr10 job renders in chunks, each with its light, and assemble writes the most of them', {
  skip: problem,
}, () => {
  const root = film()
  const job = cli(root, 'job', '--name', 'h', '--hdr10', '--master')
  assert.equal(job.status, 0, job.stderr)
  assert.equal(JSON.parse(job.stdout).delivery.color, 'hdr10-bt2020-pq')
  assert.match(cli(root, 'render', '--job', 'h', '--hdr10').stderr, /froze its range \(hdr10\)/)
  const plan = cli(root, 'plan', '--job', 'h', '--chunks', '2')
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /frames as p010/)
  for (const i of ['1', '0']) {
    const r = cli(root, 'render', '--job', 'h', '--chunk', i)
    assert.equal(r.status, 0, r.stderr)
  }
  const dir = join(root, 'out', 'h.plan')
  const records = [0, 1].map(
    (i) => JSON.parse(readFileSync(join(dir, `chunk-00${i}.mkv.json`), 'utf8')) as ChunkRecord,
  )
  for (const r of records) assert.ok(r.light && r.light.maxCll === 10000, JSON.stringify(r.light))
  const most = {
    maxCLL: Math.ceil(Math.max(...records.map((r) => r.light?.maxCll ?? 0))),
    maxFALL: Math.ceil(Math.max(...records.map((r) => r.light?.maxFall ?? 0))),
  }
  assert.deepEqual(most, referenceLight())
  const a = cli(root, 'assemble', '--plan', dir)
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /10 frames from 2 chunks/)
  assertHdr10(join(root, 'out', 'h.mp4'), most)
  // check --hdr10 hashes the P010 and reports the light; the job's chunks are lossless P010.
  const check = cli(root, 'check', '--hdr10', '--times', '3')
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /HDR10: P010 hashed; at most 10000 cd\/m² \(MaxCLL\)/)
})
