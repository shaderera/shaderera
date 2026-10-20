import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Child } from '../node/child.ts'
import { boxFrame, memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { createJob } from '../project/jobs.ts'
import { probe } from './ffmpeg.ts'
import { exportVideo } from './render.ts'

/** A fixture in its own temp folder: test files run in parallel, and each build empties `.shaderera/`. */
const copy = (dir: string) => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-fixture-'))
  cpSync(fileURLToPath(new URL(dir, import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

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
  const project = memoryProject()
  const child = memoryChild({ size: { width: 64, height: 36 }, frame: boxFrame(64, 36) })
  const out = join(mkdtempSync(join(tmpdir(), 'shaderera-partial-')), 'film.mp4')
  const partial = `${out}.partial`
  writeFileSync(out, 'the previous film')
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

test('render --job of a png job writes the finishing handoff', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = copy('./fixtures/deliver/')
  const job = await createJob(root, {
    by: 'cli',
    variant: 'square',
    name: 'sq',
    delivery: { format: 'png' },
  })
  const r = spawnSync(process.execPath, [main, 'render', '--root', root, '--job', job.name], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, 'out', 'sq')
  const d = JSON.parse(readFileSync(join(dir, 'delivery.json'), 'utf8'))
  assert.equal(d.frameCount, 5)
  assert.equal(d.versions.host.host, 'node')
  assert.ok(existsSync(join(dir, 'audio.wav')))
})

// The mix's rules are tested in mix.it.ts; this proves render reaches them.
test('render reaches the mix: a src without sound is no error, an unreadable one is named', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = copy('./fixtures/clip-audio/')
  // A video with no sound, as a film's clip param may name, and a file that is not media.
  const made = spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=16x16:d=1'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'picture.mp4')],
  ])
  assert.equal(made.status, 0, String(made.stderr))
  writeFileSync(join(root, 'broken.mp4'), 'not a video')
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-clip-audio-'))
  const render = (name: string, ...flags: string[]) => {
    const out = join(dir, name)
    const r = spawnSync(
      process.execPath,
      [main, 'render', '--root', root, '--out', out, ...flags],
      {
        encoding: 'utf8',
      },
    )
    return { ...r, out }
  }

  // The tone made in code is heard; the video without sound is not, and does not fail.
  const silent = render('silent.mp4', '--param', 'clip=picture.mp4')
  assert.equal(silent.status, 0, silent.stderr)
  assert.equal(probe(silent.out).audio?.codec, 'aac')

  const broken = render('broken.mp4', '--param', 'clip=broken.mp4')
  assert.notEqual(broken.status, 0)
  assert.match(broken.stderr, /Audio clip 1 \(broken\.mp4\) cannot be read: .*broken\.mp4/s)
  assert.equal(existsSync(broken.out), false)
})
