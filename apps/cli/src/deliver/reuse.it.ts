import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })
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
}, () => {
  const root = tempDir('reuse')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify({ ...manifest, duration: 4 }))
  const ok = (r: ReturnType<typeof cli>) => {
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const src = join(root, 'src', 'composition.ts')
  writeFileSync(src, composition('#08f'))
  ok(cli(root, 'job', '--name', 'a'))
  ok(cli(root, 'plan', '--job', 'a', '--chunks', '3'))
  for (const i of ['0', '1', '2']) ok(cli(root, 'render', '--job', 'a', '--chunk', i))
  // The edit: the box changes colour from 1.5 to 2.5 s, frames 15 to 24.
  writeFileSync(src, composition('#f80'))
  ok(cli(root, 'job', '--name', 'b'))
  const full = join(root, 'out', 'full.mp4')
  ok(cli(root, 'render', '--job', 'b', '--out', full))
  const plan = join(root, 'out', 'a.plan')
  const same = (dir: string, name: string) => {
    const out = join(root, 'out', `${name}.mp4`)
    ok(cli(root, 'assemble', '--plan', dir, '--out', out))
    assert.equal(sha(out), sha(full), `${name}: the same bytes as a full render`)
  }

  const right = ok(cli(root, 'render', '--job', 'b', '--reuse', plan, '--changed', '1.5-2.5'))
  assert.match(right, /10 frames rendered, 30 reused/)
  same(join(root, 'out', 'b.plan'), 'reused')

  // A span that misses half the edit: the boundary sample after it differs.
  const wrong = join(root, 'out', 'wrong.plan')
  const refused = cli(
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
    ok(
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
  same(fixed, 'fixed')

  // A plan that reuses a plan that reused: its frames are cut from the chunks first rendered.
  const again = join(root, 'out', 'again.plan')
  ok(cli(root, 'render', '--job', 'b', '--reuse', fixed, '--changed', '0-0.1', '--plan', again))
  const chunks = JSON.parse(readFileSync(join(again, 'plan.json'), 'utf8')).chunks
  assert.ok(chunks.some((c: { reused?: { job: string } }) => c.reused?.job === 'a'))
  same(again, 'again')

  // Another window is refused.
  ok(cli(root, 'job', '--name', 'short', '--to', '3'))
  assert.match(
    cli(root, 'render', '--job', 'short', '--reuse', plan, '--changed', '1-2').stderr,
    /same format and window/,
  )
  // A reused chunk changed after the plan reused it is refused.
  writeFileSync(join(plan, 'chunk-001.mkv'), 'x')
  assert.match(
    cli(root, 'assemble', '--plan', join(root, 'out', 'b.plan')).stderr,
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
}, () => {
  const root = tempDir('reuse')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ ...manifest, duration: 4, sequential: 3, variants: undefined }),
  )
  const ok = (r: ReturnType<typeof cli>) => {
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const src = join(root, 'src', 'composition.ts')
  writeFileSync(src, sequential(40))
  ok(cli(root, 'job', '--name', 'a'))
  ok(cli(root, 'plan', '--job', 'a', '--chunks', '2'))
  for (const i of ['0', '1']) ok(cli(root, 'render', '--job', 'a', '--chunk', i))
  writeFileSync(src, sequential(80))
  ok(cli(root, 'job', '--name', 'b'))
  const full = join(root, 'out', 'full.mp4')
  ok(cli(root, 'render', '--job', 'b', '--out', full))
  // Frames 15 to 24 changed, and the 3 after them still hold them.
  const right = ok(
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
  ok(cli(root, 'assemble', '--plan', join(root, 'out', 'b.plan'), '--out', out))
  assert.equal(sha(out), sha(full))
})
