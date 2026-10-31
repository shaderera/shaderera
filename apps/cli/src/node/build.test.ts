import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Manifest } from '@shaderera/core'
import { alive } from '../deliver/claim.ts'
import { buildNode } from './build.ts'

test('a process this user may not signal is alive', {
  skip: process.getuid?.() === 0 && 'root may signal any process',
}, () => {
  // EPERM: the System process on Windows, init elsewhere.
  assert.equal(alive(process.platform === 'win32' ? 4 : 1), true)
  assert.equal(alive(process.pid), true)
})

test('a build error leaves as plain text, without colour codes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'entry.ts'), 'export const render = (t =>\n')
  const manifest = { entry: './entry.ts' } as Manifest
  await assert.rejects(buildNode({ root, manifest }), (e: Error) => {
    assert.match(e.message, /entry\.ts/)
    assert.equal(e.message.includes('\x1b'), false)
    return true
  })
})
