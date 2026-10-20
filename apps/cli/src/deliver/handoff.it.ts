import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { createJob } from '../project/jobs.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))

test('a handoff renders the same frames from a fresh folder', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('handoff')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  await createJob(root, { by: 'cli', name: 'h', variant: 'square', delivery: { format: 'png' } })
  const handoff = spawnSync(process.execPath, [main, 'handoff', 'h', '--root', root, '--verify'], {
    encoding: 'utf8',
  })
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr)
  assert.match(handoff.stdout, /reproduced in a fresh folder .*: every sampled frame matches/)
  const dir = join(root, 'out', 'handoff', 'h')
  for (const f of [
    'shaderera.json',
    'src/composition.ts',
    'audio/tone.wav',
    'versions/jobs/h.json',
  ])
    assert.ok(existsSync(join(dir, f)), f)
  assert.equal(existsSync(join(dir, 'out')), false)
  const md = readFileSync(join(dir, 'REPRODUCE.md'), 'utf8')
  assert.match(md, /npx shaderera render --job h/)
  assert.match(md, /- Node: v\d+/)
  assert.match(md, /## Verified at handoff/)
  // No package.json or lock file: said plainly, never passed off as a production handoff.
  assert.match(handoff.stdout, /reproducible from a clean install: NO/)
  assert.match(md, /Reproducible from a clean install: no\.\*\* The revision has no package\.json/)
  assert.match(md, /relocation; not a clean install/)

  // The documented command, run in a copy of the handoff, gives the original's frame hashes.
  const original = spawnSync(process.execPath, [main, 'render', '--root', root, '--job', 'h'])
  assert.equal(original.status, 0, String(original.stderr))
  const copy = tempDir('handoff-copy')
  cpSync(dir, copy, { recursive: true })
  const again = spawnSync(process.execPath, [main, 'render', '--root', copy, '--job', 'h'])
  assert.equal(again.status, 0, String(again.stderr))
  const hashes = (r: string) =>
    JSON.parse(readFileSync(join(r, 'out', 'h', 'delivery.json'), 'utf8')).frames.map(
      (f: { sha256: string }) => f.sha256,
    )
  assert.deepEqual(hashes(copy), hashes(root))
})

test('a clean-install check installs the lock file in a fresh folder and renders the same frames', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('handoff-clean')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const pkg = { name: 'film', version: '0.0.0', private: true }
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { '': pkg } }),
  )
  await createJob(root, { by: 'cli', name: 'c' })
  const r = spawnSync(process.execPath, [main, 'handoff', 'c', '--root', root, '--clean-install'], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /reproducible from a clean install: yes/)
  assert.match(r.stdout, /reproduced from a clean install .*: every sampled frame matches/)
  const md = readFileSync(join(root, 'out', 'handoff', 'c', 'REPRODUCE.md'), 'utf8')
  assert.match(md, /\*\*Reproducible from a clean install:\*\* yes/)
  assert.match(md, /npm ci/)
})
