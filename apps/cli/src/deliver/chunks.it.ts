import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('chunks rendered apart and assembled give the very file one render gives', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = tempDir('chunks')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  // ProRes; an mp4's chunks are checked the same way in reuse.it.ts.
  assert.equal(cli(root, 'job', '--name', 'p', '--format', 'prores-hq').status, 0)
  const single = join(root, 'out', 'single.mov')
  const one = cli(root, 'render', '--job', 'p', '--out', single)
  assert.equal(one.status, 0, one.stderr)
  assert.equal(cli(root, 'plan', '--job', 'p', '--chunks', '3').status, 0)
  // Out of order, as separate machines would finish.
  for (const i of ['2', '0', '1'])
    assert.equal(cli(root, 'render', '--job', 'p', '--chunk', i).status, 0)
  const plan = join(root, 'out', 'p.plan')
  const together = join(root, 'out', 'together.mov')
  const a = cli(root, 'assemble', '--plan', plan, '--out', together)
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /10 frames from 3 chunks/)
  assert.equal(sha(together), sha(single), 'the same bytes')
  // Another job's plan never goes into this plan's folder: its plan and chunks stay as they were.
  assert.equal(cli(root, 'job', '--name', 'q', '--format', 'prores-hq').status, 0)
  const before = readFileSync(join(plan, 'plan.json'), 'utf8')
  const other = cli(root, 'plan', '--job', 'q', '--out', plan)
  assert.equal(other.status, 2, other.stderr)
  assert.match(other.stderr, /holds job p's plan \(3 chunk\(s\) rendered\).*--out .*q\.plan/)
  assert.equal(readFileSync(join(plan, 'plan.json'), 'utf8'), before)
  assert.equal(cli(root, 'assemble', '--plan', plan, '--out', together).status, 0)
  // A chunk changed after it was rendered is refused.
  writeFileSync(join(plan, 'chunk-001.mkv'), 'x')
  assert.match(cli(root, 'assemble', '--plan', plan).stderr, /chunk-001\.mkv changed/)
})

// The frames a file holds, decoded (Matroska's own header differs from one write to the next).
const frames = (file: string) =>
  spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'framemd5', '-'], {
    encoding: 'utf8',
  }).stdout.replace(/^#.*\n/gm, '')

test('a chunk spread over several hosts holds the frames one host makes', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = tempDir('chunk-workers')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  assert.equal(cli(root, 'job', '--name', 'w').status, 0)
  assert.equal(cli(root, 'plan', '--job', 'w', '--chunks', '1').status, 0)
  const file = join(root, 'out', 'w.plan', 'chunk-000.mkv')
  const one = cli(root, 'render', '--job', 'w', '--chunk', '0', '--workers', '1')
  assert.equal(one.status, 0, one.stderr)
  assert.match(one.stdout, /on 1 host\(s\)/)
  const single = frames(file)
  const two = cli(root, 'render', '--job', 'w', '--chunk', '0', '--workers', '2')
  assert.equal(two.status, 0, two.stderr)
  assert.match(two.stdout, /on 2 host\(s\)/)
  assert.equal(frames(file), single, 'the same frames on two hosts')
})
