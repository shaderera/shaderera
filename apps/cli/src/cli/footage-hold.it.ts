import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/**
 * A 3 s film of a 30-frame clip at 10 fps: variant `plays` shows it frame by frame, `held` asks
 * frame 10 from 1 s to 2 s, as a retiming that falls through to a held frame does (#521).
 */
const film = () => {
  const root = tempDir('footage-hold')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 10,
      duration: 3,
      width: 64,
      height: 36,
      variants: { plays: {}, held: {} },
    }),
  )
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "private": true }')
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `import type { Open } from '@shaderera/core'
const open: Open = async ({ io, variant }) => {
  if (!io.video) throw new Error('This film needs io.video.')
  const clip = await io.video('assets/take.mp4')
  return {
    render: async (t) => {
      const f = Math.min(clip.frames - 1, Math.round(t * 10))
      const i = variant === 'held' && f >= 10 && f <= 20 ? 10 : f
      return { color: await clip.frame(i), alpha: 'opaque', name: 'clip' }
    },
  }
}
export default open
`,
  )
  spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10', '-frames:v', '30'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', join(root, 'assets', 'take.mp4')],
  ])
  return root
}

test('review reports footage that holds one frame for 1 s, and nothing for footage that plays', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 180_000,
}, () => {
  const root = film()
  const holds = (variant: string) => {
    const r = spawnSync(
      process.execPath,
      [main, 'review', '--quick', '--variant', variant, '--root', root, '--json'],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr)
    return (
      JSON.parse(r.stdout) as { findings: { code: string; severity: string; message: string }[] }
    ).findings.filter((f) => f.code === 'footage-hold' && /holds one frame/.test(f.message))
  }
  const held = holds('held')
  assert.equal(held.length, 1)
  assert.equal(held[0]?.severity, 'info')
  assert.match(
    held[0]?.message ?? '',
    /footage holds one frame for 1 s at t=1 \(assets\/take\.mp4\)/,
  )
  // Measured, as info, with no hold to name.
  assert.deepEqual(holds('plays'), [])
})
