import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cli as run } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'
import { decodeFrames } from './chunks.ts'

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

test('chunks of one job started at the same moment all render (#433)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('chunk-together')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  // As children, as the issue ran them: each leaves its build in the frozen copy when it exits.
  assert.equal(spawned(root, 'job', '--name', 'j').status, 0)
  const planned = spawned(root, 'plan', '--job', 'j', '--chunks', '4')
  assert.equal(planned.status, 0, planned.stderr)
  // The build the plan left in the frozen copy, made as large as a real film's: every chunk
  // finds it there and removes it at the same moment.
  const node = join(root, '.shaderera', 'revisions')
  const copy = readdirSync(node).find((n) => /^[0-9a-f]{16}$/.test(n)) as string
  const left = join(node, copy, '.shaderera', 'node')
  const dead = readdirSync(left).find((n) => /^\d+-\d+$/.test(n)) as string
  assert.ok(dead, 'plan left its build')
  for (let d = 0; d < 20; d++) {
    mkdirSync(join(left, dead, 'assets', String(d)), { recursive: true })
    for (let f = 0; f < 50; f++) writeFileSync(join(left, dead, 'assets', String(d), `${f}.js`), '')
  }
  const chunk = (i: number) =>
    new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn(process.execPath, [
        main,
        'render',
        '--job',
        'j',
        '--chunk',
        String(i),
        '--root',
        root,
      ])
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => done({ status, stderr }))
    })
  const ran = await Promise.all([0, 1, 2, 3].map(chunk))
  for (const [i, r] of ran.entries()) assert.equal(r.status, 0, `chunk ${i}: ${r.stderr}`)
  assert.equal(existsSync(join(left, dead)), false, "plan's build was removed")
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

/** What ffprobe says of a file's video stream, with its packets counted, and its duration. */
const probeRate = (file: string) => {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_packets',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=r_frame_rate,nb_read_packets:format=duration',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  )
  const j = JSON.parse(r.stdout) as {
    streams: { r_frame_rate: string; nb_read_packets: string }[]
    format: { duration: string }
  }
  const s = j.streams[0] as { r_frame_rate: string; nb_read_packets: string }
  return {
    rate: s.r_frame_rate,
    packets: Number(s.nb_read_packets),
    duration: Number(j.format.duration),
  }
}

test("a chunk carries its job's frame rate, a variant's own too, and assembles at it (#442)", {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  // Rawvideo's own rate is 25: none of these is.
  const cases = [
    { fps: 30 as number | string, rate: '30/1', num: 30, den: 1 },
    { fps: '30000/1001', rate: '30000/1001', num: 30000, den: 1001 },
    { fps: 30, variant: 24, rate: '24/1', num: 24, den: 1 },
  ]
  for (const c of cases) {
    const root = tempDir('chunk-fps')
    cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
      recursive: true,
    })
    writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
    const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
    manifest.fps = c.fps
    if (c.variant) manifest.variants.square.fps = c.variant
    writeFileSync(join(root, 'shaderera.json'), JSON.stringify(manifest))
    const job = await cli(root, 'job', '--name', 'r', ...(c.variant ? ['--variant', 'square'] : []))
    assert.equal(job.status, 0, job.stderr)
    assert.equal((await cli(root, 'plan', '--job', 'r', '--chunks', '2')).status, 0)
    for (const i of ['0', '1'])
      assert.equal((await cli(root, 'render', '--job', 'r', '--chunk', i)).status, 0)
    const plan = join(root, 'out', 'r.plan')
    const chunks = (
      JSON.parse(readFileSync(join(plan, 'plan.json'), 'utf8')) as { chunks: { frames: number }[] }
    ).chunks
    const chunk = probeRate(join(plan, 'chunk-000.mkv'))
    const frames = chunks[0]?.frames as number
    assert.equal(chunk.rate, c.rate, `fps ${c.fps}${c.variant ? `, variant ${c.variant}` : ''}`)
    assert.equal(chunk.packets, frames)
    // Its frames at the job's rate, to Matroska's millisecond.
    assert.ok(
      Math.abs(chunk.duration - (frames * c.den) / c.num) <= 0.001,
      `${chunk.duration} s for ${frames} frames at ${c.rate}`,
    )
    const film = join(root, 'out', 'r.mp4')
    const a = await cli(root, 'assemble', '--plan', plan, '--out', film)
    assert.equal(a.status, 0, a.stderr)
    const total = chunks.reduce((n, k) => n + k.frames, 0)
    assert.match(a.stdout, new RegExp(`${total} frames from 2 chunks`))
    const out = probeRate(film)
    assert.equal(out.rate, c.rate)
    assert.equal(out.packets, total)
  }
})

test('decodeFrames gives each frame of a chunk once, whatever its timestamps say (#442)', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const dir = tempDir('chunk-pts')
  // Six frames of 4×2 RGBA, frame i every byte 40·i, stored as a chunk is, with a second's gap
  // in the timestamps after frame 2: a decoder that keeps to the timestamps' rate fills it.
  const raw = join(dir, 'frames.rgba')
  writeFileSync(raw, Buffer.concat([0, 1, 2, 3, 4, 5].map((i) => Buffer.alloc(32, 40 * i))))
  const file = join(dir, 'gap.mkv')
  const made = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    '4x2',
    '-framerate',
    '30',
    '-i',
    raw,
    '-vf',
    'setpts=N/(30*TB)+gte(N\\,3)/TB',
    '-fps_mode',
    'passthrough',
    '-c:v',
    'ffv1',
    '-pix_fmt',
    'bgra',
    file,
  ])
  assert.equal(made.status, 0, String(made.stderr))
  const plan = { input: 'rgba', width: 4, height: 2 } as const
  const firsts: number[] = []
  for await (const f of decodeFrames(plan, file, 6)) firsts.push(f[0] as number)
  assert.deepEqual(firsts, [0, 40, 80, 120, 160, 200])
  const picked: number[] = []
  for await (const f of decodeFrames(plan, file, 2, 'gte(n\\,3)')) picked.push(f[0] as number)
  assert.deepEqual(picked, [120, 160])
})
