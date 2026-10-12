import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodePng } from './png.ts'

test('a 16-bit PNG holds the compositor rgba64 words exactly, read back by ffmpeg', {
  skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'no ffmpeg',
}, () => {
  const words = new Uint16Array([0, 1, 257, 65535, 40000, 12345, 65534, 32768])
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-png16-'))
  try {
    const file = join(dir, 'f.png')
    writeFileSync(file, encodePng(new Uint8Array(words.buffer), 2, 1, 16))
    const r = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-pix_fmt',
      'rgba64le',
      '-f',
      'rawvideo',
      '-',
    ])
    const back = new Uint16Array(
      r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length),
    )
    assert.deepEqual([...back], [...words])
    assert.throws(() => encodePng(new Uint8Array(8), 2, 1, 16), /needs 16 bytes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
