import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/** A film whose variant `long` reads a clip with a keyframe every 250 frames, `short` every 30. */
const film = () => {
  const root = tempDir('keyframes')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 30,
      duration: 1,
      width: 64,
      height: 36,
      variants: { long: {}, short: {} },
    }),
  )
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "private": true }')
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `import type { Open } from '@shaderera/core'
const open: Open = async ({ io, variant }) => {
  if (!io.video) throw new Error('This film needs io.video.')
  const clip = await io.video(variant === 'long' ? 'assets/long.mp4' : 'assets/short.mp4')
  return {
    render: async (t) => ({
      color: await clip.frame(Math.min(clip.frames - 1, Math.floor(t * 30 + 1e-6))),
      alpha: 'opaque',
      name: 'clip',
    }),
  }
}
export default open
`,
  )
  for (const [name, gop] of [
    ['long', 250],
    ['short', 30],
  ] as const) {
    const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=30', '-t', '5']
    const x264 = ['-c:v', 'libx264', '-g', String(gop), '-sc_threshold', '0', '-pix_fmt', 'yuv420p']
    spawnSync('ffmpeg', [...args, ...x264, join(root, 'assets', `${name}.mp4`)])
  }
  return root
}

test('check --variants notes a long keyframe gap once, for the clip that has it', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 120_000,
}, () => {
  const root = film()
  const r = spawnSync(
    process.execPath,
    [main, 'check', '--times', '6', '--variants', 'long,short', '--root', root, '--json'],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  const notes = (
    JSON.parse(r.stdout) as { findings: { code: string; message: string; output?: string }[] }
  ).findings.filter((f) => f.code === 'keyframes')
  assert.equal(notes.length, 1, JSON.stringify(notes))
  assert.match(notes[0]?.message ?? '', /^assets\/long\.mp4: keyframes up to 5\.0 s apart/)
  // Each variant alone: the long one notes it, the short one does not.
  const one = (variant: string) =>
    spawnSync(
      process.execPath,
      [main, 'check', '--times', '6', '--variant', variant, '--root', root],
      {
        encoding: 'utf8',
      },
    ).stdout
  assert.match(one('long'), /! assets\/long\.mp4: keyframes up to 5\.0 s apart/)
  assert.doesNotMatch(one('short'), /keyframes/)
})
