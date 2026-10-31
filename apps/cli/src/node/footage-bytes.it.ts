import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { type VideoFormat, videoDecoder } from './decoder.ts'
import { probeVideo } from './services.ts'

const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const FRAMES = 120

/** FNV-1a of a frame's bytes, the same in the film (below) and here. */
const hash = (b: Uint8Array) => {
  let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ (b[i] as number), 0x01000193) >>> 0
  return h.toString(16)
}

/**
 * A film that asks each frame in order, the one before it again (held), one 15 back every 40
 * frames (a jump back) and one 60 ahead every 40 (a jump far ahead, a seek), in RGBA and yuv420p,
 * and prints the hash of every frame io.video returns.
 */
const film = () => {
  const root = tempDir('footage-bytes')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/c.ts', fps: 30, duration: FRAMES / 30, width: 64, height: 36 }),
  )
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "private": true }')
  writeFileSync(
    join(root, 'src', 'c.ts'),
    `const hash = ${hash.toString()}
export default async ({ io }) => {
  const clip = await io.video('clip.mp4')
  const last = clip.frames - 1
  return {
    render: async (t, o) => {
      const f = o.frame
      const asks = [f, Math.max(0, f - 1)]
      if (f % 40 === 20) asks.push(f - 15)
      if (f % 40 === 5) asks.push(Math.min(last, f + 60))
      let color
      for (const i of asks)
        for (const format of ['rgba', 'yuv420p']) {
          const b = await clip.frame(i, { format })
          console.error(\`frame \${format} \${i} \${hash(b)}\`)
          if (format === 'rgba' && i === f) color = b
        }
      return { color, alpha: 'opaque' }
    },
  }
}
`,
  )
  // Short GOPs, so a jump starts the decoder at a keyframe past frame 0.
  const r = spawnSync('ffmpeg', [
    ...[
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x36:rate=30',
      '-frames:v',
      `${FRAMES}`,
    ],
    ...['-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')],
  ])
  assert.equal(r.status, 0, String(r.stderr))
  return root
}

/** Each frame of the clip in `format`, decoded from frame 0 in order on one thread, as before. */
const reference = async (file: string, format: VideoFormat) => {
  const d = videoDecoder(
    file,
    { ...probeVideo(file), format },
    undefined,
    undefined,
    undefined,
    undefined,
    1,
  )
  try {
    const out: string[] = []
    for (let i = 0; i < FRAMES; i++) out.push(hash(await d.frame(i)))
    return out
  } finally {
    await d.close()
  }
}

test('io.video gives the same bytes on four decoding threads as on one, with 1 and 4 hosts, held, back and far ahead (ADR 0030)', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 300_000,
}, async () => {
  const root = film()
  const file = join(root, 'clip.mp4')
  const want = { rgba: await reference(file, 'rgba'), yuv420p: await reference(file, 'yuv420p') }
  for (const workers of ['1', '4']) {
    const run = spawnSync(
      process.execPath,
      [
        ...[main, 'render', '--root', root, '--out', join(root, 'out', `film-${workers}.mp4`)],
        ...['--no-audio', '--workers', workers],
      ],
      { encoding: 'utf8' },
    )
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr + run.stdout, new RegExp(`on ${workers} host\\(s\\)`))
    let seen = 0
    const asked = new Set<string>()
    for (const m of run.stderr.matchAll(/^frame (rgba|yuv420p) (\d+) ([0-9a-f]+)$/gm)) {
      const [, format, i, h] = m as unknown as [string, 'rgba' | 'yuv420p', string, string]
      assert.equal(h, want[format][Number(i)], `${workers} host(s): ${format} frame ${i}`)
      asked.add(`${format} ${i}`)
      seen++
    }
    // Every frame in both formats, plus the held, back and far-ahead ones (and the re-check's).
    assert.equal(asked.size, 2 * FRAMES, `${workers} host(s)`)
    assert.ok(seen > 4 * FRAMES, `${workers} host(s): ${seen} frames`)
  }
})
