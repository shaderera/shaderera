import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { measureLoudness } from '../cli/ffmpeg.ts'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [main, ...args, '--root', root], { encoding: 'utf8' })
const ok = (r: ReturnType<typeof cli>) => {
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** A file's video (or audio) packets, each with its timing and md5, as stored (not decoded). */
const packets = (file: string, stream: 'v' | 'a' = 'v') =>
  spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-i', file, '-map', `0:${stream}`, '-c', 'copy', '-f', 'framemd5', '-'],
    { encoding: 'utf8' },
  ).stdout.replace(/^#.*\n/gm, '')

/** A box moving over 3 s, a tone at `gain`, a caption; `throws`: render fails at every frame. */
const composition = (o: { box: string; gain: number; caption: string; throws?: boolean }) =>
  `import type { Open } from '@shaderera/core'
const open: Open = ({ io, manifest }) => {
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  return {
    render: async (t) => {
      ${o.throws ? "throw new Error('a frame was rendered')" : ''}
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '${o.box}'
      ctx.fillRect(4 + t * 10, 10, 8, 8)
      return { color: canvas }
    },
    audio: async () => [{ src: 'audio/tone.wav', at: 0.2, gain: ${o.gain} }],
    captions: async () => [{ start: 0.5, end: 2, text: '${o.caption}' }],
  }
}
export default open
`

const project = (name: string) => {
  const root = tempDir(name)
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify({ ...manifest, duration: 3 }))
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1 }))
  return { root, src: join(root, 'src', 'composition.ts') }
}

test('reexport audio puts a changed mix on the very video packets of the file', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const { root, src } = project('reexport-audio')
  writeFileSync(src, composition({ box: '#08f', gain: 1, caption: 'Hello' }))
  ok(cli(root, 'job', '--name', 'a', '--master'))
  ok(cli(root, 'render', '--job', 'a'))
  const a = join(root, 'out', 'a.mp4')
  const before = measureLoudness(a)?.integrated as number

  // The gain halved in a new revision: the picture is the same, the sound 6.02 dB down.
  writeFileSync(src, composition({ box: '#08f', gain: 0.5, caption: 'Hello' }))
  ok(cli(root, 'job', '--name', 'b', '--master'))
  const said = ok(cli(root, 'reexport', 'audio', '--job', 'b', '--onto', a))
  assert.match(said, /the video of .*a\.mp4 \(job a\), no frames rendered or encoded/)
  const b = join(root, 'out', 'b.mp4')
  assert.equal(packets(b), packets(a), 'the same video packets')
  assert.ok(packets(a).length > 0)
  const after = measureLoudness(b)?.integrated as number
  assert.ok(Math.abs(before - after - 6.02) < 0.1, `${before} → ${after} LUFS`)
  const full = join(root, 'out', 'b-full.mp4')
  ok(cli(root, 'render', '--job', 'b', '--out', full))
  // Packet for packet the file a full render of job b gives (only the tags' order differs).
  assert.equal(packets(b, 'a'), packets(full, 'a'), 'the audio a render gives')
  assert.equal(packets(b), packets(full))
  assert.match(
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', b], {
      encoding: 'utf8',
    }).stdout,
    new RegExp(
      `shaderera_revision=${JSON.parse(readFileSync(join(root, 'versions', 'jobs', 'b.json'), 'utf8')).revision}`,
    ),
  )

  // A loudness on the same job's file, in place.
  ok(cli(root, 'reexport', 'audio', '--job', 'b', '--loudness=-20'))
  assert.equal(packets(b), packets(a))
  assert.ok(Math.abs((measureLoudness(b)?.integrated as number) + 20) < 0.1)
  // No sound at all.
  const silent = join(root, 'out', 'silent.mp4')
  ok(cli(root, 'reexport', 'audio', '--job', 'b', '--no-audio', '--out', silent))
  assert.equal(packets(silent), packets(a))
  assert.equal(measureLoudness(silent), null)

  // A picture that changed is refused, by the frames rendered in both jobs.
  writeFileSync(src, composition({ box: '#f80', gain: 0.5, caption: 'Hello' }))
  ok(cli(root, 'job', '--name', 'c', '--master'))
  const c = join(root, 'out', 'c.mp4')
  const refused = cli(root, 'reexport', 'audio', '--job', 'c', '--onto', a)
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /Job c draws other frames than job a, which made .*a\.mp4, at t 0 s/)
  assert.equal(existsSync(c), false, 'nothing written')
  // So is a file of another picture setting (review quality, not master).
  ok(cli(root, 'job', '--name', 'r'))
  assert.match(
    cli(root, 'reexport', 'audio', '--job', 'r', '--onto', a).stderr,
    /is of job a, whose picture is not job r's \(delivery/,
  )
})

test('reexport captions writes the sidecars and renders no frame', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const { root, src } = project('reexport-captions')
  // Every frame throws: a frame rendered would fail the command.
  writeFileSync(src, composition({ box: '#08f', gain: 1, caption: 'Second take', throws: true }))
  ok(cli(root, 'job', '--name', 'a'))
  const said = ok(cli(root, 'reexport', 'captions', '--job', 'a'))
  assert.match(said, /1 captions, no frames rendered/)
  assert.match(
    readFileSync(join(root, 'out', 'a.srt'), 'utf8'),
    /00:00:00,500 --> 00:00:02,000\nSecond take/,
  )
  assert.match(readFileSync(join(root, 'out', 'a.vtt'), 'utf8'), /^WEBVTT/)
  assert.equal(existsSync(join(root, 'out', 'a.mp4')), false)
})

test('assemble encodes another delivery of the job from the same chunks', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const { root, src } = project('reexport-assemble')
  writeFileSync(src, composition({ box: '#08f', gain: 1, caption: 'Hello' }))
  ok(cli(root, 'job', '--name', 'a', '--master'))
  ok(cli(root, 'plan', '--job', 'a', '--chunks', '2'))
  for (const i of ['0', '1']) ok(cli(root, 'render', '--job', 'a', '--chunk', i))
  const plan = join(root, 'out', 'a.plan')

  // Another crf: the same frames, another encode.
  const crf = join(root, 'out', 'crf.mp4')
  ok(cli(root, 'assemble', '--plan', plan, '--crf', '30', '--out', crf))
  ok(cli(root, 'assemble', '--plan', plan))
  assert.ok(readFileSync(crf).length < readFileSync(join(root, 'out', 'a.mp4')).length)

  // Another job of the same revision and window with another delivery: the file its render gives.
  ok(cli(root, 'job', '--name', 'm', '--master', '--no-edit-list'))
  const assembled = join(root, 'out', 'm-assembled.mp4')
  ok(cli(root, 'assemble', '--plan', plan, '--job', 'm', '--out', assembled, '--loudness=-20'))
  const rendered = join(root, 'out', 'm.mp4')
  ok(cli(root, 'render', '--job', 'm', '--loudness=-20'))
  assert.equal(sha(assembled), sha(rendered), 'the same bytes as render --job m')

  // A job of another revision is refused.
  writeFileSync(src, composition({ box: '#f80', gain: 1, caption: 'Hello' }))
  ok(cli(root, 'job', '--name', 'other', '--master'))
  assert.match(
    cli(root, 'assemble', '--plan', plan, '--job', 'other').stderr,
    /Job other is not another delivery of job a, whose chunks these are: its revision/,
  )
})

test('reexport audio gives the sound a render gives without edit lists and in a ProRes mov', {
  skip: !ffmpeg && 'no ffmpeg',
}, () => {
  const { root, src } = project('reexport-formats')
  writeFileSync(src, composition({ box: '#08f', gain: 1, caption: 'Hello' }))
  for (const [name, ext, ...flags] of [
    ['n', 'mp4', '--master', '--no-edit-list'],
    ['p', 'mov', '--format', 'prores-hq'],
  ] as const) {
    ok(cli(root, 'job', '--name', name, ...flags))
    ok(cli(root, 'render', '--job', name))
    const file = join(root, 'out', `${name}.${ext}`)
    const video = packets(file)
    const said = ok(cli(root, 'reexport', 'audio', '--job', name, '--loudness=-20'))
    assert.match(said, name === 'n' ? /no edit list/ : /prores/)
    assert.equal(packets(file), video, `${name}: the same video packets`)
    const rendered = join(root, 'out', `${name}-rendered.${ext}`)
    ok(cli(root, 'render', '--job', name, '--loudness=-20', '--out', rendered))
    assert.equal(packets(file, 'a'), packets(rendered, 'a'), `${name}: the audio a render gives`)
    const probe = (f: string) =>
      spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_entries', 'stream=start_time,duration', f],
        {
          encoding: 'utf8',
        },
      ).stdout
    assert.equal(probe(file), probe(rendered), `${name}: the same timing`)
  }
})
