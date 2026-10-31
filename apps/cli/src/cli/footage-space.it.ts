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
 * A film of a 10-bit clip: variant `bare` opens it with no space and reads it as RGBA, `declared`
 * says what it is and reads its 10-bit planes too (#575).
 */
const film = () => {
  const root = tempDir('footage-space')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 10,
      duration: 0.5,
      width: 64,
      height: 36,
      variants: { bare: {}, declared: {} },
    }),
  )
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "private": true }')
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `import type { Open } from '@shaderera/core'
const open: Open = async ({ io, variant }) => {
  if (!io.video) throw new Error('This film needs io.video.')
  const declared = variant === 'declared'
  const clip = declared
    ? await io.video('assets/log.mkv', { transfer: 'slog3', gamut: 'sgamut3cine' })
    : await io.video('assets/log.mkv')
  return {
    render: async (t) => {
      const i = Math.min(clip.frames - 1, Math.floor(t * 10 + 1e-6))
      if (declared) await clip.frame(i, { format: 'yuv420p10' })
      return { color: await clip.frame(i), alpha: 'opaque', name: 'clip' }
    },
  }
}
export default open
`,
  )
  spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10', '-frames:v', '5'],
    ...['-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', join(root, 'assets', 'log.mkv')],
  ])
  return root
}

test('check warns of 10-bit footage with no declared space or read only at 8 bits, not of declared footage read at 10', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 120_000,
}, () => {
  const root = film()
  const check = (variant: string) => {
    const r = spawnSync(
      process.execPath,
      [main, 'check', '--samples', '3', '--variant', variant, '--root', root, '--json'],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr)
    return (
      JSON.parse(r.stdout) as { findings: { code: string; severity: string; message: string }[] }
    ).findings.filter((f) => f.code.startsWith('footage-'))
  }
  const bare = check('bare')
  assert.deepEqual(
    bare.map((f) => [f.code, f.severity]),
    [
      ['footage-space', 'warning'],
      ['footage-bits', 'warning'],
    ],
  )
  assert.match(bare[0]?.message ?? '', /^assets\/log\.mkv: 10-bit footage with no colour space/)
  assert.deepEqual(check('declared'), [])
})
