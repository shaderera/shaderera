import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Ran, cli as run } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const cli = (root: string, ...args: string[]) => run(...args, '--root', root)
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** A box moving over 4 s with a tone; `edit` is its colour from 1.5 to 2.5 s. */
const composition = (edit: string) => `import type { Open } from '@shaderera/core'
const open: Open = ({ io, manifest }) => {
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  return {
    render: async (t) => {
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = t >= 1.5 && t < 2.5 ? '${edit}' : '#08f'
      ctx.fillRect(4 + t * 10, 10, 8, 8)
      return { color: canvas }
    },
    audio: async () => [{ src: 'audio/tone.wav', at: 0.2 }],
  }
}
export default open
`

test('a job rendered from an earlier plan and its changed spans is the file a full render gives', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('reuse')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify({ ...manifest, duration: 4 }))
  const ok = async (ran: Promise<Ran>) => {
    const r = await ran
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const src = join(root, 'src', 'composition.ts')
  writeFileSync(src, composition('#08f'))
  await ok(cli(root, 'job', '--name', 'a'))
  await ok(cli(root, 'plan', '--job', 'a', '--chunks', '3'))
  for (const i of ['0', '1', '2']) await ok(cli(root, 'render', '--job', 'a', '--chunk', i))
  // The edit: the box changes colour from 1.5 to 2.5 s, frames 15 to 24.
  writeFileSync(src, composition('#f80'))
  await ok(cli(root, 'job', '--name', 'b'))
  const full = join(root, 'out', 'full.mp4')
  await ok(cli(root, 'render', '--job', 'b', '--out', full))
  const plan = join(root, 'out', 'a.plan')
  const same = async (dir: string, name: string) => {
    const out = join(root, 'out', `${name}.mp4`)
    await ok(cli(root, 'assemble', '--plan', dir, '--out', out))
    assert.equal(sha(out), sha(full), `${name}: the same bytes as a full render`)
  }

  const right = await ok(cli(root, 'render', '--job', 'b', '--reuse', plan, '--changed', '1.5-2.5'))
  assert.match(right, /10 frames rendered, 30 reused/)
  await same(join(root, 'out', 'b.plan'), 'reused')

  // A span that misses half the edit: the boundary sample after it differs.
  const wrong = join(root, 'out', 'wrong.plan')
  const refused = await cli(
    root,
    'render',
    '--job',
    'b',
    '--reuse',
    plan,
    '--changed',
    '1.5-2',
    '--plan',
    wrong,
  )
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /frame 20 \(t 2 s\) in the unchanged span 2–4 s/)
  assert.equal(existsSync(join(wrong, 'plan.json')), false, 'nothing written')
  // --fix renders around the frames that differed, up to the samples that matched.
  const fixed = join(root, 'out', 'fixed.plan')
  assert.match(
    await ok(
      cli(
        root,
        'render',
        '--job',
        'b',
        '--reuse',
        plan,
        '--changed',
        '1.5-2',
        '--fix',
        '--plan',
        fixed,
      ),
    ),
    /--fix: rendered around frames 20, 22/,
  )
  await same(fixed, 'fixed')

  // A plan that reuses a plan that reused: its frames are cut from the chunks first rendered.
  const again = join(root, 'out', 'again.plan')
  await ok(
    cli(root, 'render', '--job', 'b', '--reuse', fixed, '--changed', '0-0.1', '--plan', again),
  )
  const chunks = JSON.parse(readFileSync(join(again, 'plan.json'), 'utf8')).chunks
  assert.ok(chunks.some((c: { reused?: { job: string } }) => c.reused?.job === 'a'))
  await same(again, 'again')

  // Another window is refused.
  await ok(cli(root, 'job', '--name', 'short', '--to', '3'))
  assert.match(
    (await cli(root, 'render', '--job', 'short', '--reuse', plan, '--changed', '1-2')).stderr,
    /same format and window/,
  )
  // A reused chunk rendered again with the same frames is the same file: the plan still takes it.
  await ok(cli(root, 'render', '--job', 'a', '--chunk', '1'))
  await same(join(root, 'out', 'b.plan'), 'rerendered')
  // A chunk rendered again whose frames changed (here chunk 0's frames, recorded as a render
  // would) is refused.
  const record = join(plan, 'chunk-001.mkv.json')
  const kept = readFileSync(record, 'utf8')
  const keptFile = readFileSync(join(plan, 'chunk-001.mkv'))
  cpSync(join(plan, 'chunk-000.mkv'), join(plan, 'chunk-001.mkv'))
  writeFileSync(
    record,
    JSON.stringify({ ...JSON.parse(kept), sha256: sha(join(plan, 'chunk-001.mkv')) }),
  )
  assert.match(
    (await cli(root, 'assemble', '--plan', join(root, 'out', 'b.plan'))).stderr,
    /chunk-001\.mkv of job a's plan .* is no longer the chunk that chunk \d+ reuses/,
  )
  writeFileSync(record, kept)
  writeFileSync(join(plan, 'chunk-001.mkv'), keptFile)
  // A reused chunk changed after the plan reused it is refused.
  writeFileSync(join(plan, 'chunk-001.mkv'), 'x')
  assert.match(
    (await cli(root, 'assemble', '--plan', join(root, 'out', 'b.plan'))).stderr,
    /chunk-001\.mkv changed after it was rendered/,
  )
})

/** A sequential source with a lookback of 3: each frame is its value plus the 3 before it. */
const sequential = (edit: number) => `export default ({ manifest }) => {
  const recent = []
  return {
    async render(t) {
      const v = t >= 1.5 && t < 2.5 ? ${edit} : 40
      const sum = recent.reduce((a, b) => a + b, v)
      recent.push(v)
      if (recent.length > 3) recent.shift()
      return { color: new Uint8Array(manifest.width * manifest.height * 4).fill(sum % 256), alpha: 'opaque' }
    },
  }
}
`

test('a changed span of a sequential source reaches forward by its lookback', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('reuse')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ ...manifest, duration: 4, sequential: 3, variants: undefined }),
  )
  const ok = async (ran: Promise<Ran>) => {
    const r = await ran
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const src = join(root, 'src', 'composition.ts')
  writeFileSync(src, sequential(40))
  await ok(cli(root, 'job', '--name', 'a'))
  await ok(cli(root, 'plan', '--job', 'a', '--chunks', '2'))
  for (const i of ['0', '1']) await ok(cli(root, 'render', '--job', 'a', '--chunk', i))
  writeFileSync(src, sequential(80))
  await ok(cli(root, 'job', '--name', 'b'))
  const full = join(root, 'out', 'full.mp4')
  await ok(cli(root, 'render', '--job', 'b', '--out', full))
  // Frames 15 to 24 changed, and the 3 after them still hold them.
  const right = await ok(
    cli(
      root,
      'render',
      '--job',
      'b',
      '--reuse',
      join(root, 'out', 'a.plan'),
      '--changed',
      '1.5-2.5',
    ),
  )
  assert.match(right, /13 frames rendered, 27 reused/)
  const out = join(root, 'out', 'reused.mp4')
  await ok(cli(root, 'assemble', '--plan', join(root, 'out', 'b.plan'), '--out', out))
  assert.equal(sha(out), sha(full))
})
