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
  // A chunk changed after it was rendered is refused.
  writeFileSync(join(plan, 'chunk-001.mkv'), 'x')
  assert.match(cli(root, 'assemble', '--plan', plan).stderr, /chunk-001\.mkv changed/)
})
