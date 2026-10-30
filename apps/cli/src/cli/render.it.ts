import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cli as run } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'
import type { Child } from '../node/child.ts'
import { boxFrame, memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { canEncode, encodersFile, probe } from './ffmpeg.ts'
import type { FrameTime } from './frame-time.ts'
import { exportVideo } from './render.ts'

/** A fixture in its own temp folder: test files run in parallel, and each build empties `.shaderera/`. */
const copy = (dir: string) => {
  const root = tempDir('fixture')
  cpSync(fileURLToPath(new URL(dir, import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

// The other CLI tests run it in their own process (fixtures/cli.ts); this one starts it as a user
// does, through bin/shaderera.js, piped.
test('a piped render reports every frame only when asked (a parent process asks); a variant renders at its own length', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const bin = fileURLToPath(new URL('../../bin/shaderera.js', import.meta.url))
  const root = copy('./fixtures/mcp/')
  const out = join(tempDir('render'), 'film.mp4')
  const render = (...flags: string[]) =>
    spawnSync(process.execPath, [bin, 'render', '--root', root, '--out', out, ...flags], {
      encoding: 'utf8',
    })
  const asked = render('--progress')
  assert.equal(asked.status, 0, asked.stderr)
  assert.match(asked.stderr, /frame 1\/10\b.*frame 10\/10 {2}[\d.]+ fps {2}0:00 left/s)
  // Where the frame time went (#454), at the end.
  assert.match(
    asked.stdout,
    /^time: [\d.]+ ms a frame · on the host: drawing [\d.]+ ms, compositor and readback [\d.]+ ms, waiting on io\.video [\d.]+ ms · encoder (idle|busy) \(/m,
  )
  // Unasked, and a variant: at its own length, done before a line every 10 s is due.
  const quiet = render('--variant', 'short')
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.doesNotMatch(quiet.stderr, /frame \d+\//)
  assert.match(quiet.stdout, /^5 frames in/m)
  // A window that is not one is refused before ffmpeg runs.
  const backwards = render('--from', '0.8', '--to', '0.2')
  assert.equal(backwards.status, 2)
  assert.match(backwards.stderr, /--to must be after --from \(0\.8–0\.2 s\)\./)
  assert.doesNotMatch(backwards.stderr, /ffmpeg|failed where it worked/)
  assert.match(render('--from', 'a').stderr, /Not a time in seconds: a\./)
})

test("a render's frame time adds up: the hosts' drawing, io.video, compositor and readback and the encoder make the frame (#497)", {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = copy('./fixtures/mcp/')
  // 60 frames at 720p: large enough that the compositor and readback are a real part of each.
  const manifest = join(root, 'shaderera.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      ...JSON.parse(readFileSync(manifest, 'utf8')),
      width: 1280,
      height: 720,
      fps: 30,
      duration: 2,
    }),
  )
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    [
      "import type { Open } from '@shaderera/core'",
      'const open: Open = ({ io }) => {',
      '  const canvas = io.canvas(1280, 720)',
      '  return {',
      '    render: async (t) => {',
      "      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D",
      "      ctx.fillStyle = 'rgb(20, 20, 40)'",
      '      ctx.fillRect(0, 0, 1280, 720)',
      "      ctx.fillStyle = 'rgb(255, 120, 0)'",
      '      ctx.fillRect(t * 600, 200, 160, 160)',
      "      return { color: canvas, name: 'box' }",
      '    },',
      '  }',
      '}',
      'export default open',
    ].join('\n'),
  )
  const out = join(tempDir('render'), 'film.mp4')
  const r = spawnSync(
    process.execPath,
    [main, 'render', '--root', root, '--out', out, '--no-audio', '--workers', '1', '--json'],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  const found = (
    JSON.parse(r.stdout) as { findings: { code: string; measured?: string }[] }
  ).findings.find((f) => f.code === 'frame-time')
  assert.ok(found?.measured, r.stdout)
  const t = JSON.parse(found.measured) as FrameTime
  assert.ok(t.composeMs > 0, found.measured)
  // Within a quarter of the frame, as docs/cli.md says: the rest is the CLI's own work on a frame.
  const parts = (t.renderMs + t.composeMs) / Math.max(1, t.hosts) + t.encoderMs
  assert.ok(
    Math.abs(parts - t.frameMs) <= t.frameMs / 4,
    `the parts ${parts.toFixed(2)} ms of a ${t.frameMs.toFixed(2)} ms frame: ${found.measured}`,
  )
})

test('the output holds the previous film until the new one is complete; a failed render leaves it', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const project = memoryProject()
  const child = memoryChild({ size: { width: 64, height: 36 }, frame: boxFrame(64, 36) })
  const out = join(tempDir('partial'), 'film.mp4')
  const partial = `${out}.${process.pid}.partial`
  writeFileSync(out, 'the previous film')
  // Another render to the same out, still running in another process: its file is its own.
  const other = `${out}.${process.ppid}.partial`
  writeFileSync(other, 'another render')
  // One killed outright, whose process is gone: what it left goes.
  const killed = `${out}.${spawnSync(process.execPath, ['-e', '']).pid}.partial`
  writeFileSync(killed, 'a killed render')
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
  assert.equal(existsSync(killed), false)
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
  assert.equal(readFileSync(other, 'utf8'), 'another render')

  // Finished, but the output cannot be replaced (a folder here; on Windows, a file a player
  // holds open): the new film is kept as .partial and the error says where it is.
  const blocked = join(dirname(out), 'blocked.mp4')
  mkdirSync(join(blocked, 'inside'), { recursive: true })
  await assert.rejects(
    exportVideo(project, child, { out: blocked, revision: 'test' }),
    /The film is finished, but .*blocked\.mp4 could not be replaced .* The new film is .*blocked\.mp4\.\d+\.partial/,
  )
  assert.equal(probe(`${blocked}.${process.pid}.partial`).video?.frames, 10)
  // Such a kept film, left by a process that is gone, survives the next render of its out; a
  // half-written partial of a dead process does not.
  const kept = join(dirname(out), 'kept.mp4')
  const finishedFilm = `${kept}.${spawnSync(process.execPath, ['-e', '']).pid}.partial`
  const halfFilm = `${kept}.${spawnSync(process.execPath, ['-e', '']).pid}.partial`
  copyFileSync(`${blocked}.${process.pid}.partial`, finishedFilm)
  writeFileSync(halfFilm, readFileSync(finishedFilm).subarray(0, 600))
  await exportVideo(project, child, { out: kept, revision: 'test' })
  assert.equal(probe(finishedFilm).video?.frames, 10)
  assert.equal(existsSync(halfFilm), false)

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
}, async () => {
  const root = copy('./fixtures/mcp/')
  const cli = (...args: string[]) => run(...args, '--root', root)
  const out = join(root, 'out', 'film.mp4')
  const r = await cli('render', '--out', out)
  assert.equal(r.status, 0, r.stderr)
  const id = /^revision: (\w+)$/m.exec(r.stdout)?.[1]
  const versions = async () => JSON.parse((await cli('versions', '--json')).stdout).result
  assert.equal((await versions()).head, id)
  assert.equal(probe(out).revision, id)
  // --json: the file, the frames and the revision as fields, not lines.
  const json = JSON.parse((await cli('render', '--out', out, '--json')).stdout)
  assert.deepEqual(
    [json.result.out, json.result.frames, json.result.revision, json.log],
    [out, 10, id, undefined],
  )
  assert.equal(json.result.host.host, 'node')

  // Unchanged files: the same revision, and save says so instead of echoing its label.
  assert.equal(
    (await cli('save', '--label', 'again')).stdout.trim(),
    `same files as revision ${id}; label added`,
  )

  const job = await cli('job', '--name', 'final', '--to', '0.5', '--json')
  assert.equal(job.status, 0, job.stderr)
  assert.deepEqual(
    [JSON.parse(job.stdout).result.name, JSON.parse(job.stdout).result.revision],
    ['final', id],
  )
  writeFileSync(join(root, 'notes.txt'), 'a change after the job')
  const saves = (await versions()).log.length
  const frozen = await cli('render', '--job', 'final')
  assert.equal(frozen.status, 0, frozen.stderr)
  assert.equal((await versions()).log.length, saves)
  assert.equal(probe(join(root, 'out', 'final.mp4')).revision, id)
  // Its frozen copy stays for the next render, unmarked: its marks folder went with its last user.
  const frozenCopy = join(root, '.shaderera', 'revisions', id as string)
  assert.ok(existsSync(join(frozenCopy, 'shaderera.json')))
  assert.equal(existsSync(`${frozenCopy}.using`), false)
  assert.equal((await cli('render', '--job', 'final')).status, 0)
  assert.ok(existsSync(join(frozenCopy, 'shaderera.json')))
})

test('after prune --keep 0, render --job and restore still work, and diff says the pruned one was', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = copy('./fixtures/mcp/')
  const cli = (...args: string[]) => run(...args, '--root', root)
  const saveWith = async (text: string, ...flags: string[]) => {
    writeFileSync(join(root, 'asset.bin'), text)
    const r = await cli('save', ...flags)
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.split(' ')[0] as string
  }
  const a = await saveWith('A only')
  assert.equal((await cli('job', '--name', 'final', '--to', '0.5', '--revision', a)).status, 0)
  const b = await saveWith('B only')
  await saveWith('C only', '--label', 'client round 1')
  // Older than the minutes a save beside the prune may still be using them.
  const objects = join(root, 'versions', 'objects')
  const old = new Date(Date.now() - 24 * 3600_000)
  for (const o of readdirSync(objects)) utimesSync(join(objects, o), old, old)
  const before = readdirSync(objects).length

  const dry = await cli('prune', '--dry-run', '--keep', '0')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, new RegExp(`would remove ${b}`))
  assert.match(
    dry.stdout,
    /would remove 1 revision\(s\), 1 object\(s\) and 0 frozen copy\(ies\).*dry run/,
  )
  assert.equal(readdirSync(objects).length, before)

  const pruned = await cli('prune', '--keep', '0')
  assert.equal(pruned.status, 0, pruned.stderr)
  assert.match(pruned.stdout, new RegExp(`removed ${b}`))
  assert.equal(readdirSync(objects).length, before - 1)
  assert.match((await cli('versions')).stdout, new RegExp(`${b} .*\\(pruned\\)`))
  const diff = await cli('diff', b)
  assert.equal(diff.status, 2)
  assert.match(diff.stderr, new RegExp(`Revision ${b} was pruned`))

  const render = await cli('render', '--job', 'final')
  assert.equal(render.status, 0, render.stderr)
  assert.equal(probe(join(root, 'out', 'final.mp4')).revision, a)
  assert.equal((await cli('restore', a)).status, 0)
  assert.equal(readFileSync(join(root, 'asset.bin'), 'utf8'), 'A only')
})

// The mix's rules are tested in mix.it.ts; this proves render reaches them.
test('render reaches the mix: a src without sound is no error, an unreadable one is named', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = copy('./fixtures/clip-audio/')
  // A video with no sound, as a film's clip param may name, and a file that is not media.
  const made = spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=16x16:d=1'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'picture.mp4')],
  ])
  assert.equal(made.status, 0, String(made.stderr))
  writeFileSync(join(root, 'broken.mp4'), 'not a video')
  const dir = tempDir('clip-audio')
  const render = async (name: string, ...flags: string[]) => {
    const out = join(dir, name)
    return { ...(await run('render', '--root', root, '--out', out, ...flags)), out }
  }

  // The tone made in code is heard; the video without sound is not, and does not fail.
  const silent = await render('silent.mp4', '--param', 'clip=picture.mp4')
  assert.equal(silent.status, 0, silent.stderr)
  assert.equal(probe(silent.out).audio?.codec, 'aac')

  const broken = await render('broken.mp4', '--param', 'clip=broken.mp4')
  assert.notEqual(broken.status, 0)
  assert.match(broken.stderr, /Audio clip 1 \(broken\.mp4\) cannot be read: .*broken\.mp4/s)
  assert.equal(existsSync(broken.out), false)
})

test("a render's hosts open at once: each host's open overlaps the others'", {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const root = copy('./fixtures/mcp/')
  // An open that takes 2 s, as a film's that decodes its pictures does, and says when it ran: the
  // host's console goes to the render's stderr.
  const entry = join(root, 'src', 'composition.ts')
  writeFileSync(
    entry,
    readFileSync(entry, 'utf8').replace(
      'const open: Open = ({ io }) => {',
      [
        'const open: Open = async ({ io }) => {',
        '  const opening = Date.now()',
        '  await new Promise((done) => setTimeout(done, 2000))',
        "  console.error('open from ' + opening + ' to ' + Date.now())",
      ].join('\n'),
    ),
  )
  const out = join(tempDir('render'), 'film.mp4')
  const r = spawnSync(
    process.execPath,
    [main, 'render', '--root', root, '--out', out, '--no-audio', '--workers', '2'],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.includes('on 2 host(s)'), r.stdout)
  const opens = [...r.stderr.matchAll(/open from (\d+) to (\d+)/g)].map((m) => ({
    from: Number(m[1]),
    to: Number(m[2]),
  }))
  assert.equal(opens.length, 2, r.stderr)
  // At once: every open began before any other ended. One after the other, the later begins
  // after the earlier ends, however fast the machine.
  const lastFrom = Math.max(...opens.map((o) => o.from))
  const firstTo = Math.min(...opens.map((o) => o.to))
  assert.ok(lastFrom < firstTo, `the opens did not overlap: ${JSON.stringify(opens)}`)
})

test('A GPU encoder failing where a kept answer said yes: the answer is dropped and x264 renders the film, once', {
  skip: !ffmpeg && 'no ffmpeg',
}, async (t) => {
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = process.env.USERPROFILE = tempDir('home')
  try {
    // This ffmpeg's key (at a size no other test asks: a process keeps its answers), then a yes
    // for 66×38, which NVENC refuses (too small): as a GPU gone since.
    // The other GPU encoders are kept as no, so NVENC is the one picked.
    await canEncode('nvenc', 68, 40)
    const { ffmpeg: key } = JSON.parse(readFileSync(encodersFile(), 'utf8'))
    const answers = { 'nvenc 66x38': true, 'qsv 66x38': false, 'amf 66x38': false }
    writeFileSync(
      encodersFile(),
      JSON.stringify({ ffmpeg: key, answers: { ...answers, 'videotoolbox 66x38': false } }),
    )
    const warn = t.mock.method(console, 'warn', () => {})
    const project = memoryProject({ width: 66, height: 38 })
    const child = memoryChild({ size: { width: 66, height: 38 }, frame: boxFrame(66, 38) })
    const out = join(tempDir('retry'), 'film.mp4')
    const r = await exportVideo(project, child, { out, revision: 'test' })
    assert.equal(r.encoder, 'x264')
    assert.equal(r.frames, 10)
    assert.equal(warn.mock.callCount(), 1)
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /nvenc failed .* again/)
    const left = JSON.parse(readFileSync(encodersFile(), 'utf8')).answers
    assert.equal(left['nvenc 66x38'], undefined)
    // Asked by name, NVENC is never swapped for x264: the failure is the render's.
    await assert.rejects(
      exportVideo(project, child, { out, revision: 'test', encoder: 'nvenc' }),
      /cannot encode with nvenc/,
    )
  } finally {
    Object.assign(process.env, home)
  }
})

test('render --draft: 360 px high at full fps, or the height given, beside the review file', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = copy('./fixtures/ratios/')
  const cli = (...args: string[]) => run(...args, '--root', root)
  const name = basename(root)
  const r = await cli('render', '--draft', '--progress', '--to', '1')
  assert.equal(r.status, 0, r.stderr)
  // A window beside the whole film (#466): its seconds in the name.
  const out = join(root, 'out', `${name}-draft-0.0-1.0.mp4`)
  assert.equal(r.stdout.split('\n')[0], out)
  assert.match(r.stdout, /^10 frames in [\d.]+ s on \d+ host\(s\), \w+, draft \(640×360\)$/m)
  assert.match(r.stderr, /frame 10\/10 {2}draft \(640×360\)/)
  const p = probe(out)
  assert.deepEqual([p.video?.width, p.video?.height, p.video?.fps], [640, 360, 10])
  // Another height: as wide as the film's aspect.
  assert.equal((await cli('render', '--draft', '540', '--to', '0.2')).status, 0)
  const tall = probe(join(root, 'out', `${name}-draft-0.0-0.2.mp4`))
  assert.deepEqual([tall.video?.width, tall.video?.height], [960, 540])
  // The review file is not touched, and a variant's draft has its own aspect.
  assert.equal(existsSync(join(root, 'out', `${name}.mp4`)), false)
  const v = await cli('render', '--draft', '--variant', '9:16', '--from', '1.5')
  assert.equal(v.status, 0, v.stderr)
  const portrait = probe(join(root, 'out', `${name}-9_16-draft-1.5-2.0.mp4`))
  assert.deepEqual([portrait.video?.width, portrait.video?.height], [202, 360])
  assert.match(v.stdout, /^5 frames in .*draft \(202×360\)$/m)
  // A job is a frozen final: never a draft.
  assert.equal((await cli('job', '--name', 'final', '--to', '0.5')).status, 0)
  const job = await cli('render', '--job', 'final', '--draft')
  assert.equal(job.status, 2)
  assert.match(job.stderr, /--draft is a review render of the working tree, never a job/)
})

test('render --draft refuses a source that draws at a size of its own, naming both sizes', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  // This fixture draws on a 64×36 canvas whatever size it is opened at.
  const root = copy('./fixtures/mcp/')
  const r = await run('render', '--draft', '18', '--root', root)
  assert.notEqual(r.status, 0)
  assert.match(
    r.stderr,
    /A layer's canvas is 64x36, but this render \(render --draft, or review's readback\) opened the source at 32x18: draw at host\.manifest's width and height/,
  )
})

test("render --draft: a clip's frames come from the decoder scaled as the frame is", {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('draft-clip')
  mkdirSync(join(root, 'src'))
  const clip = [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x36:rate=10',
    '-frames:v',
    '10',
  ]
  spawnSync('ffmpeg', [...clip, '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')])
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/c.ts', fps: 10, duration: 1, width: 64, height: 36 }),
  )
  // The clip fills the frame pixel for pixel: it must come at the frame's size.
  writeFileSync(
    join(root, 'src', 'c.ts'),
    `export default async ({ io, manifest }) => {
  const clip = await io.video('clip.mp4')
  if (clip.width !== manifest.width || clip.height !== manifest.height)
    throw new Error(\`clip \${clip.width}x\${clip.height}, frame \${manifest.width}x\${manifest.height}\`)
  return {
    render: async (t, o) => ({ color: await clip.frame(o.frame), alpha: 'straight' }),
  }
}
`,
  )
  const draft = await run('render', '--draft', '18', '--root', root)
  assert.equal(draft.status, 0, draft.stderr)
  const p = probe(join(root, 'out', `${basename(root)}-draft.mp4`))
  assert.deepEqual([p.video?.width, p.video?.height], [32, 18])
  const full = await run('render', '--root', root)
  assert.equal(full.status, 0, full.stderr)
})
