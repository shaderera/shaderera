import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Child } from '../node/child.ts'
import { open } from './args.ts'
import { probe } from './ffmpeg.ts'
import { exportVideo, frameError } from './render.ts'

/** A fixture in its own temp folder: test files run in parallel, and each build empties `.shaderera/`. */
const copy = (dir: string) => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-fixture-'))
  cpSync(fileURLToPath(new URL(dir, import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}
const stateful = copy('./fixtures/stateful/')
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

test('render refuses a source that is not deterministic and leaves no file', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const { project, child } = await open({ root: stateful })
  const out = join(stateful, 'out', 'refused.mp4')
  try {
    await assert.rejects(
      exportVideo(project, child, { out, revision: 'test' }),
      /Not exported: the source is not deterministic \(t=[\d.]+ after t=[\d.]+: pixels/,
    )
    assert.equal(existsSync(out), false)
  } finally {
    await child.close()
  }
})

test('a piped render reports progress only when asked (a parent process asks)', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = copy('./fixtures/mcp/')
  const out = join(mkdtempSync(join(tmpdir(), 'shaderera-render-')), 'film.mp4')
  const render = (...flags: string[]) =>
    spawnSync(process.execPath, [main, 'render', '--root', root, '--out', out, ...flags], {
      encoding: 'utf8',
    })
  const asked = render('--progress')
  assert.equal(asked.status, 0, asked.stderr)
  assert.match(asked.stderr, /frame 1\/10 .*frame 10\/10/s)
  const quiet = render()
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.doesNotMatch(quiet.stderr, /frame \d+\//)
  assert.match(quiet.stdout, /10 frames in/)
})

test('a variant renders at its own length', { skip: !ffmpeg && 'no ffmpeg' }, () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = copy('./fixtures/mcp/')
  const out = join(mkdtempSync(join(tmpdir(), 'shaderera-variant-')), 'short.mp4')
  const r = spawnSync(
    process.execPath,
    [main, 'render', '--root', root, '--variant', 'short', '--out', out],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^5 frames in/m)
})

test('the output holds the previous film until the new one is complete; a failed render leaves it', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const { project, child } = await open({ root: copy('./fixtures/mcp/') })
  const out = join(mkdtempSync(join(tmpdir(), 'shaderera-partial-')), 'film.mp4')
  const partial = `${out}.partial`
  writeFileSync(out, 'the previous film')
  try {
    // Interrupted midway (Ctrl-C): the new frames went to .partial, never to the output.
    const stop = new AbortController()
    await assert.rejects(
      exportVideo(project, child, {
        out,
        revision: 'test',
        signal: stop.signal,
        onFrame: (i) => {
          if (i !== 3) return
          assert.equal(readFileSync(out, 'utf8'), 'the previous film')
          stop.abort(new Error('Interrupted'))
        },
      }),
      /Interrupted/,
    )
    assert.equal(existsSync(partial), false)
    assert.equal(readFileSync(out, 'utf8'), 'the previous film')

    // A host whose device is lost at 0.5 s: the render fails with that frame and never writes it.
    const lost: Child = {
      ...child,
      render: (t, ...rest) =>
        t >= 0.5
          ? Promise.reject(new Error('The WebGPU device was lost (Device removed)'))
          : child.render(t, ...rest),
    }
    await assert.rejects(
      exportVideo(project, lost, { out, revision: 'test' }),
      /^Error: Frame 5 \(t 0\.5 s\) failed: The WebGPU device was lost \(Device removed\)/,
    )
    assert.equal(existsSync(partial), false)
    assert.equal(readFileSync(out, 'utf8'), 'the previous film')

    // Finished, but the output cannot be replaced (a folder here; on Windows, a file a player
    // holds open): the new film is kept as .partial and the error says where it is.
    const blocked = join(dirname(out), 'blocked.mp4')
    mkdirSync(join(blocked, 'inside'), { recursive: true })
    await assert.rejects(
      exportVideo(project, child, { out: blocked, revision: 'test' }),
      /The film is finished, but .*blocked\.mp4 could not be replaced .* The new film is .*blocked\.mp4\.partial/,
    )
    assert.equal(probe(`${blocked}.partial`).video?.frames, 10)

    // In the project but not in out/: it would be saved into every later revision.
    await assert.rejects(
      exportVideo(project, child, { out: join(project.root, 'film.mp4'), revision: 'test' }),
      /film\.mp4 is in the project but not in out\//,
    )

    // Complete: renamed over the previous film.
    await exportVideo(project, child, { out, revision: 'test' })
    assert.equal(existsSync(partial), false)
    assert.equal(probe(out).video?.frames, 10)
  } finally {
    await child.close()
  }
})

test('a device error names its frame and, with several hosts, fewer --workers', () => {
  const lost = new Error('The WebGPU device was lost (Device removed)')
  assert.match(frameError(lost, 2, 30, 4).message, /^Frame 60 \(t 2 s\) failed: .*fewer --workers/)
  assert.doesNotMatch(frameError(lost, 2, 30, 1).message, /--workers/)
  assert.equal(
    frameError(new Error('x is undefined'), 2, 30, 4).message,
    'Frame 60 (t 2 s) failed: x is undefined',
  )
})

test('render saves the revision it renders and tags the file; render --job saves nothing', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = copy('./fixtures/mcp/')
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })
  const out = join(root, 'out', 'film.mp4')
  const r = cli('render', '--out', out)
  assert.equal(r.status, 0, r.stderr)
  const id = /^revision: (\w+)$/m.exec(r.stdout)?.[1]
  const versions = () => JSON.parse(cli('versions', '--json').stdout).result
  assert.equal(versions().head, id)
  assert.equal(probe(out).revision, id)

  // Unchanged files: the same revision, and save says so instead of echoing its label.
  assert.equal(
    cli('save', '--label', 'again').stdout.trim(),
    `same files as revision ${id}; label added`,
  )

  const job = cli('job', '--name', 'final', '--to', '0.5')
  assert.equal(job.status, 0, job.stderr)
  writeFileSync(join(root, 'notes.txt'), 'a change after the job')
  const saves = versions().log.length
  const frozen = cli('render', '--job', 'final')
  assert.equal(frozen.status, 0, frozen.stderr)
  assert.equal(versions().log.length, saves)
  assert.equal(probe(join(root, 'out', 'final.mp4')).revision, id)
})
