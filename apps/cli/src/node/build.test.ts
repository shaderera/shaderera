import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alive } from './build.ts'

test('a process this user may not signal is alive', {
  skip: process.getuid?.() === 0 && 'root may signal any process',
}, () => {
  // EPERM: the System process on Windows, init elsewhere.
  assert.equal(alive(process.platform === 'win32' ? 4 : 1), true)
  assert.equal(alive(process.pid), true)
})
