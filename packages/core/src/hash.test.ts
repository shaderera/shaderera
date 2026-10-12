import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from './hash.ts'

test('sha256 hashes bytes to hex', async () => {
  assert.equal(
    await sha256(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})
