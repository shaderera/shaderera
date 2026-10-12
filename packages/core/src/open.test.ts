import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSource } from './open.ts'
import type { Host } from './protocol.ts'

const host = { seed: 7 } as unknown as Host
const render = async () => ({ color: new Uint8Array(4), alpha: 'opaque' as const })

test('openSource takes a Source or calls an Open with the host', async () => {
  const source = { render }
  assert.equal(await openSource({ default: source }, host), source)
  let got: Host | undefined
  const open = async (h: Host) => {
    got = h
    return { render }
  }
  const opened = await openSource({ default: open }, host)
  assert.equal(got, host)
  assert.equal(opened.render, render)
})

test('openSource rejects a module without a usable default', async () => {
  await assert.rejects(openSource({}, host), /no default export/)
  await assert.rejects(openSource({ default: {} }, host), /render/)
})
