import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { outputRequirements, requiredChecks } from '../project/requirements.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const fixture = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `shaderera-${name}-`))
  cpSync(fileURLToPath(new URL(`../cli/fixtures/${name}/`, import.meta.url)), root, {
    recursive: true,
  })
  return root
}
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args], { encoding: 'utf8' })

test('there is no default safe area: an output is judged only on what requirements.json declares', () => {
  const tall = { width: 1080, height: 1920, fps: 30, duration: 2 }
  assert.equal(outputRequirements({ version: 1 }, tall).safeArea, undefined)
  const declared = { top: 0.14, right: 0.06, bottom: 0.35, left: 0.06 }
  assert.deepEqual(outputRequirements({ version: 1, safeArea: declared }, tall).safeArea, declared)
  assert.deepEqual([...requiredChecks({ version: 1 })].sort(), [
    'assets',
    'build',
    'determinism',
    'requirements',
  ])
  assert.deepEqual(
    [
      ...requiredChecks({
        version: 1,
        endHold: 1,
        readingTime: { min: 0.8, charsPerSecond: 15 },
        textOverlap: 0.1,
        noBlankFrames: true,
        safeArea: declared,
      }),
    ].sort(),
    [
      'assets',
      'blank-frames',
      'build',
      'determinism',
      'end-hold',
      'reading',
      'requirements',
      'text-fit',
      'text-overlap',
    ],
  )
})

test('deliver renders and reviews each variant with its own format and writes the index', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = fixture('mcp')
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1, endHold: 0 }))
  const r = cli('deliver', '--root', root, '--variants', 'short,teaser', '--name', 'b')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stderr, /output 1\/2 b-short\noutput 2\/2 b-teaser/)
  const dir = join(root, 'out', 'deliveries', 'b')
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  assert.deepEqual(
    index.outputs.map((o: { job: string; duration: number; status: string }) => [
      o.job,
      o.duration,
      o.status,
    ]),
    [
      ['b-short', 0.5, 'pass'],
      ['b-teaser', 0.3, 'pass'],
    ],
  )
  for (const o of index.outputs) {
    assert.ok(existsSync(join(dir, o.file)) && o.bytes > 0)
    assert.ok(existsSync(join(dir, o.contactSheet)))
    const format = o.checks.find((c: { id: string }) => c.id === 'format')
    assert.equal(format.status, 'pass', JSON.stringify(format))
  }
  assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /\| pass \| b-teaser \|/)
})

test('deliver exits 1 when an output fails a required check, after rendering the rest', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = fixture('mcp')
  // An end hold longer than the film: required by the requirements, so it fails the output.
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1, endHold: 60 }))
  const r = cli('deliver', '--root', root, '--variants', 'short,teaser', '--name', 'f')
  assert.equal(r.status, 1)
  const index = JSON.parse(readFileSync(join(root, 'out', 'deliveries', 'f', 'index.json'), 'utf8'))
  assert.equal(index.outputs.length, 2)
  assert.ok(index.outputs.every((o: { file?: string }) => o.file))
})

test('deliver refuses a locale the project does not declare, before rendering', () => {
  const root = fixture('mcp')
  const r = cli('deliver', '--root', root, '--locales', 'en,th', '--name', 'l')
  // 2: the command could not run (1 is a delivery that ran and failed a check).
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Locales need a "locale" param/)
  assert.equal(existsSync(join(root, 'out', 'deliveries', 'l')), false)
  const declared = fixture('deliver')
  const bad = cli('deliver', '--root', declared, '--locales', 'fr', '--name', 'l')
  assert.match(bad.stderr, /Unknown locale fr: the locale param allows en, th/)
})

test('deliver over variants × locales as png sets the locale param per job', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = fixture('deliver')
  const r = cli(
    'deliver',
    '--root',
    root,
    '--variants',
    'square',
    '--locales',
    'en,th',
    '--png',
    '--name',
    'p',
  )
  const dir = join(root, 'out', 'deliveries', 'p')
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  assert.deepEqual(
    index.outputs.map((o: { job: string; locale: string; format: string }) => [
      o.job,
      o.locale,
      o.format,
    ]),
    [
      ['p-square-en', 'en', 'png'],
      ['p-square-th', 'th', 'png'],
    ],
    r.stderr,
  )
  const d = JSON.parse(readFileSync(join(dir, 'p-square-th', 'delivery.json'), 'utf8'))
  assert.equal(d.params.locale, 'th')
  assert.equal(d.frameCount, 5)
})

test('a declared placement checks the delivered file, and passes once the file is made for it', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = fixture('mcp')
  const silentScreen = {
    name: 'a silent screen',
    containers: ['mp4'],
    videoCodecs: ['h264'],
    audio: 'none',
    maxBitrate: 10_000_000,
    durations: [0.5],
    editList: false,
  }
  writeFileSync(
    join(root, 'requirements.json'),
    JSON.stringify({ version: 1, placements: { short: silentScreen } }),
  )
  const placement = (batch: string) => {
    const index = JSON.parse(
      readFileSync(join(root, 'out', 'deliveries', batch, 'index.json'), 'utf8'),
    )
    return index.outputs[0].checks.find((c: { id: string }) => c.id === 'placement')
  }
  const plain = cli('deliver', '--root', root, '--variants', 'short', '--name', 'p1')
  assert.equal(plain.status, 1, plain.stdout + plain.stderr)
  assert.equal(placement('p1').status, 'fail')
  assert.match(placement('p1').detail, /an edit list \(--no-edit-list\)/)
  const made = cli(
    'deliver',
    '--root',
    root,
    '--variants',
    'short',
    '--name',
    'p2',
    '--no-edit-list',
    '--no-audio',
  )
  assert.equal(made.status, 0, made.stdout + made.stderr)
  assert.equal(placement('p2').status, 'pass')
  assert.match(placement('p2').measured, /mp4, h264 64×36 10 fps, 0\.5 s, .*no audio, no edit list/)
})
