import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cli as run } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const cli = (root: string, ...args: string[]) => run(...args, '--root', root)
/** As a child: a chunk's claim names the process that renders it, and this one holds a claim. */
const spawned = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('chunks rendered apart and assembled give the very file one render gives', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('chunks')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  // ProRes; an mp4's chunks are checked the same way in reuse.it.ts.
  assert.equal((await cli(root, 'job', '--name', 'p', '--format', 'prores-hq')).status, 0)
  const single = join(root, 'out', 'single.mov')
  const one = await cli(root, 'render', '--job', 'p', '--out', single)
  assert.equal(one.status, 0, one.stderr)
  assert.equal((await cli(root, 'plan', '--job', 'p', '--chunks', '3')).status, 0)
  // Out of order, as separate machines would finish.
  for (const i of ['2', '0', '1'])
    assert.equal((await cli(root, 'render', '--job', 'p', '--chunk', i)).status, 0)
  const plan = join(root, 'out', 'p.plan')
  const together = join(root, 'out', 'together.mov')
  const a = await cli(root, 'assemble', '--plan', plan, '--out', together)
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /10 frames from 3 chunks/)
  assert.equal(sha(together), sha(single), 'the same bytes')
  // Another job's plan never goes into this plan's folder: its plan and chunks stay as they were.
  assert.equal((await cli(root, 'job', '--name', 'q', '--format', 'prores-hq')).status, 0)
  const before = readFileSync(join(plan, 'plan.json'), 'utf8')
  const other = await cli(root, 'plan', '--job', 'q', '--out', plan)
  assert.equal(other.status, 2, other.stderr)
  assert.match(other.stderr, /holds job p's plan \(3 chunk\(s\) rendered\).*--out .*q\.plan/)
  assert.equal(readFileSync(join(plan, 'plan.json'), 'utf8'), before)
  assert.equal((await cli(root, 'assemble', '--plan', plan, '--out', together)).status, 0)
  // A chunk changed after it was rendered is refused.
  writeFileSync(join(plan, 'chunk-001.mkv'), 'x')
  assert.match((await cli(root, 'assemble', '--plan', plan)).stderr, /chunk-001\.mkv changed/)
  // Chunk 0 is gone and chunk 2 stopped part way: --status says where each chunk stands.
  rmSync(join(plan, 'chunk-000.mkv.json'))
  rmSync(join(plan, 'chunk-002.mkv.json'))
  writeFileSync(join(plan, 'chunk-002.mkv.99999.partial.mkv'), 'part')
  const text = await cli(root, 'plan', '--status', '--plan', plan, '--verify')
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /chunk +0 +missing/)
  assert.match(text.stdout, /chunk +1 +changed/)
  assert.match(text.stdout, /chunk +2 +partial/)
  assert.match(text.stdout, /0\/10 frames done/)
  const json = await cli(root, 'plan', '--status', '--plan', plan, '--verify', '--json')
  const status = JSON.parse(json.stdout).result
  assert.deepEqual(
    status.chunks.map((c: { status: string }) => c.status),
    ['missing', 'changed', 'partial'],
  )
  assert.deepEqual(status.frames, { done: 0, total: 10 })
  // assemble lists every problem at once, each with the command that fixes it.
  const all = await cli(root, 'assemble', '--plan', plan)
  assert.equal(all.status, 2)
  assert.match(all.stderr, /3 problems in the plan/)
  for (const i of [0, 1, 2])
    assert.match(all.stderr, new RegExp(`shaderera render --job p --chunk ${i} --plan`))
})

test('a chunk rendered again, on one host or several, is the same file', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('chunk-workers')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  assert.equal((await cli(root, 'job', '--name', 'w')).status, 0)
  assert.equal((await cli(root, 'plan', '--job', 'w', '--chunks', '1')).status, 0)
  const file = join(root, 'out', 'w.plan', 'chunk-000.mkv')
  const one = await cli(root, 'render', '--job', 'w', '--chunk', '0', '--workers', '1')
  assert.equal(one.status, 0, one.stderr)
  assert.match(one.stdout, /on 1 host\(s\)/)
  const single = sha(file)
  const again = await cli(root, 'render', '--job', 'w', '--chunk', '0', '--workers', '1')
  assert.equal(again.status, 0, again.stderr)
  assert.equal(sha(file), single, 'the same bytes rendered again')
  const two = await cli(root, 'render', '--job', 'w', '--chunk', '0', '--workers', '2')
  assert.equal(two.status, 0, two.stderr)
  assert.match(two.stdout, /on 2 host\(s\)/)
  assert.equal(sha(file), single, 'the same bytes on two hosts')
})

test('a killed render leaves nothing on re-run, and a chunk another render holds is refused', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const root = tempDir('chunk-claims')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  assert.equal(spawned(root, 'job', '--name', 'k').status, 0)
  assert.equal(spawned(root, 'plan', '--job', 'k', '--chunks', '1').status, 0)
  const plan = join(root, 'out', 'k.plan')
  // What a killed chunk render leaves: its partial, a record cut short, and its claim.
  const gone = spawnSync(process.execPath, ['-e', '']).pid as number
  writeFileSync(join(plan, `chunk-000.mkv.${gone}.partial.mkv`), 'part')
  writeFileSync(join(plan, `chunk-000.mkv.json.${gone}.tmp`), '{')
  writeFileSync(
    join(plan, 'chunk-000.mkv.claim'),
    JSON.stringify({ host: hostname(), pid: gone, at: 'then' }),
  )
  const again = spawned(root, 'render', '--job', 'k', '--chunk', '0')
  assert.equal(again.status, 0, again.stderr)
  assert.deepEqual(readdirSync(plan).sort(), ['chunk-000.mkv', 'chunk-000.mkv.json', 'plan.json'])
  // A chunk a live render holds is refused, naming it, and left as it was.
  const before = sha(join(plan, 'chunk-000.mkv'))
  writeFileSync(
    join(plan, 'chunk-000.mkv.claim'),
    JSON.stringify({ host: hostname(), pid: process.pid, at: 'now' }),
  )
  const refused = spawned(root, 'render', '--job', 'k', '--chunk', '0')
  assert.equal(refused.status, 2)
  assert.ok(
    refused.stderr.includes(`being rendered by ${hostname()} (pid ${process.pid}`),
    refused.stderr,
  )
  assert.equal(sha(join(plan, 'chunk-000.mkv')), before)
  assert.ok(existsSync(join(plan, 'chunk-000.mkv.claim')), "the other render's claim stays")
  // A plain render removes what a killed render of the same file left.
  const film = join(root, 'out', 'k.mp4')
  writeFileSync(`${film}.${gone}.partial`, 'part')
  assert.equal(spawned(root, 'render', '--job', 'k', '--out', film).status, 0)
  assert.equal(existsSync(`${film}.${gone}.partial`), false)
})
